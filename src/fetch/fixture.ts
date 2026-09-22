import { readFile } from 'node:fs/promises';
import type { Transport, HttpRequest, HttpResponse } from './types.ts';

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
