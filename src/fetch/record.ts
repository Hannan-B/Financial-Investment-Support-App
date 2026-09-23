import type { Source, Transport, Outcome, HttpResponse } from './types.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { Db } from '../db/types.ts';
import { runSource } from './run.ts';

export interface FetchDeps {
  readonly transport: Transport;
  readonly db: Db;
  readonly diagnostics: Diagnostics;
  readonly now?: () => Date;
}

/**
 * Fetch one source and record how it went.  §10.1, §10.8
 *
 * `runSource` decides the outcome; this makes it durable:
 *   ok          → keep the response as last-good; health reset
 *   suspect     → keep the response as last-failed; log it; health counts it
 *   unavailable → log it; health counts it (a 404 for weeks is also a hole)
 *
 * It does not store the parsed data — that is the caller's job, and only
 * ever for `ok`.
 */
export async function fetchSource<T>(
  source: Source<T>,
  key: string,
  deps: FetchDeps,
): Promise<Outcome<T> & { readonly response?: HttpResponse }> {
  const out = await runSource(source, key, deps.transport);
  const at = (deps.now ?? (() => new Date()))().toISOString();

  if (out.kind === 'ok') {
    if (out.response) await deps.diagnostics.saveResponse(source.id, 'last-good', out.response);
    await deps.db.query(
      `INSERT INTO source_health (source, last_ok_at, consecutive_failures) VALUES (?, ?, 0)
       ON CONFLICT (source) DO UPDATE SET
         last_ok_at = excluded.last_ok_at, consecutive_failures = 0, failing_since = NULL`,
      [source.id, at],
    );
    return out;
  }

  // Only a response that failed validation is worth keeping: it is what gets
  // diffed against last-good. A 406 or 404 body says nothing about the format.
  const saved = out.kind === 'suspect' && out.response
    ? await deps.diagnostics.saveResponse(source.id, 'last-failed', out.response)
    : undefined;

  const summary = out.kind === 'suspect'
    ? `${out.failure.check}: expected ${out.failure.expected}; ${out.failure.observed}`
    : out.reason;

  await deps.diagnostics.appendLog({
    at,
    source: source.id,
    key,
    url: source.request(key).url,
    kind: out.kind,
    ...(out.response ? { status: out.response.status } : {}),
    ...(out.kind === 'suspect' ? out.failure : { reason: out.reason }),
    ...(saved ? { response: saved } : {}),
  });

  await deps.db.query(
    `INSERT INTO source_health
       (source, last_failed_at, last_failure_kind, last_failure, failing_since, consecutive_failures)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT (source) DO UPDATE SET
       last_failed_at = excluded.last_failed_at,
       last_failure_kind = excluded.last_failure_kind,
       last_failure = excluded.last_failure,
       failing_since = coalesce(source_health.failing_since, excluded.failing_since),
       consecutive_failures = source_health.consecutive_failures + 1`,
    [source.id, at, out.kind, summary, at],
  );
  return out;
}
