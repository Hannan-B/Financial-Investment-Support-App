import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport, HttpRequest, HttpResponse } from './types.ts';
import type { Diagnostics, FailureLogEntry } from './diagnostics.ts';

/**
 * Replays a saved response instead of calling the network.  §10.8 requirement 4
 *
 * This exists so a fix can be verified against a site that is currently broken,
 * and so repeated testing never risks being blocked.
 *
 * Note: no constructor parameter properties anywhere in this project — Node's
 * built-in type stripping cannot handle them (they generate code rather than
 * merely removing types), and we run tests without a build step.
 */
export class FixtureTransport implements Transport {
  readonly #files: Readonly<Record<string, string>>;
  readonly #contentType: string;
  readonly #status: number;

  constructor(
    files: Readonly<Record<string, string>>,
    contentType = 'text/csv',
    status = 200,
  ) {
    this.#files = files;
    this.#contentType = contentType;
    this.#status = status;
  }

  async get(request: HttpRequest): Promise<HttpResponse> {
    const path = this.#files[request.url];
    if (!path) throw new Error(`no fixture registered for ${request.url}`);
    return { status: this.#status, body: await readFile(path), contentType: this.#contentType };
  }
}

/** A transport that always fails, for exercising the unavailable path. */
export class OfflineTransport implements Transport {
  async get(): Promise<HttpResponse> {
    throw new Error('no internet');
  }
}

/** A transport that returns a given status, for exercising rate limits etc. */
export class StatusTransport implements Transport {
  readonly #status: number;
  constructor(status: number) {
    this.#status = status;
  }
  async get(): Promise<HttpResponse> {
    return { status: this.#status, body: new Uint8Array(), contentType: 'text/plain' };
  }
}

/** Diagnostics kept in memory, so tests can see what would have been written. */
export class MemoryDiagnostics implements Diagnostics {
  readonly saved = new Map<string, HttpResponse>();
  readonly log: FailureLogEntry[] = [];

  async saveResponse(source: string, which: 'last-good' | 'last-failed', response: HttpResponse): Promise<string> {
    const name = `${source}/${which}`;
    this.saved.set(name, response);
    return name;
  }

  async appendLog(entry: FailureLogEntry): Promise<void> {
    this.log.push(entry);
  }
}

/**
 * Google News, as far as the app can tell: given saved answers, it returns
 * only the stories inside the query's after:/before: dates, and never more
 * than 100 — so splitting busy months is exercised against real stories.
 */
export class FakeGoogleNews {
  readonly asked: { after: string; before: string; query: string }[] = [];
  readonly #items: { xml: string; date: Date }[];
  constructor(...feeds: string[]) {
    this.#items = feeds.flatMap((xml) => [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].map((m) => ({
      xml: m[0], date: new Date(/<pubDate>([^<]+)<\/pubDate>/.exec(m[0])![1]!),
    })));
  }
  answer(url: string): HttpResponse {
    const q = new URL(url).searchParams.get('q') ?? '';
    const after = /after:(\S+)/.exec(q)?.[1] ?? '1970-01-01';
    const before = /before:(\S+)/.exec(q)?.[1] ?? '2999-01-01';
    this.asked.push({ after, before, query: q });
    const hits = this.#items.filter((i) => i.date >= new Date(after) && i.date < new Date(before)).slice(0, 100);
    const body = `<?xml version="1.0"?><rss version="2.0"><channel>${hits.map((h) => h.xml).join('')}</channel></rss>`;
    return { status: 200, body: new TextEncoder().encode(body), contentType: 'application/xml' };
  }
}

/**
 * Yahoo's history page around a saved chart response, in the shape the real
 * page carries it (seen 2026-11-13; `yahoo-aapl-history.html`): the chart
 * JSON as a string inside a SvelteKit data block. Lets the responses captured
 * on 2026-10-05 from Yahoo's data address keep testing everything after
 * prices, now that the app reads the page (PROJECT-PLAN.md appendix, *Phase 5*).
 */
export function yahooHistoryPage(chartJson: string, symbol: string): string {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?events=capitalGain%7Cdiv%7Csplit&amp;formatted=true&amp;includeAdjustedClose=true&amp;interval=1d';
  const block = JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: chartJson });
  return `<!doctype html><html><body><table></table>` +
    `<script type="application/json" data-sveltekit-fetched data-url="${url}" data-ttl="10">${block}</script>` +
    `</body></html>`;
}

/** A saved chart response (path) wrapped as the history page, written to a temporary file. */
export async function yahooPageFixture(chartPath: string, symbol: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'yahoo-page-')), `${symbol}.html`);
  await writeFile(path, yahooHistoryPage(await readFile(chartPath, 'utf8'), symbol));
  return path;
}

