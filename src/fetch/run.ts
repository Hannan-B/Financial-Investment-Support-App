import { NO_TOOLS, type Source, type Transport, type Outcome, type HttpResponse, type ParseTools } from './types.ts';

/** Statuses that mean "no data", as distinct from "wrong data". §10.2 */
function unavailableReason(status: number): string | null {
  if (status === 429) return 'rate limited';
  // ⚠️ Invesco signals throttling with 406, not 429 (§4.2).
  if (status === 406) return 'refused (406 — may be throttling)';
  if (status === 408) return 'timeout';
  if (status === 401) return 'key invalid or revoked';
  if (status === 403) return 'refused — check IP restriction or permissions';
  if (status === 404) return 'not found for this security';
  if (status >= 500) return `server error (${status})`;
  return null;
}

export async function runSource<T>(
  source: Source<T>,
  key: string,
  transport: Transport,
  tools: ParseTools = NO_TOOLS,
): Promise<Outcome<T> & { readonly response?: HttpResponse }> {
  let response: HttpResponse;
  try {
    response = await transport.get(source.request(key));
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }

  const reason = unavailableReason(response.status);
  if (reason) return { kind: 'unavailable', reason, response };
  if (response.status !== 200) {
    return { kind: 'unavailable', reason: `unexpected status ${response.status}`, response };
  }

  let parsed: T;
  try {
    parsed = await source.parse(response, tools);
  } catch (e) {
    // It answered, but we could not read it — that is breakage, not absence.
    return {
      kind: 'suspect',
      failure: {
        check: 'parse',
        expected: 'a readable response in the expected shape',
        observed: e instanceof Error ? e.message : String(e),
      },
      response,
    };
  }

  for (const check of source.checks) {
    const failure = check.run(parsed);
    if (failure) return { kind: 'suspect', failure, response };
  }

  return { kind: 'ok', value: parsed, response };
}
