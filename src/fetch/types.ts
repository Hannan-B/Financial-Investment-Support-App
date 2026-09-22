/**
 * The fetch layer.  PROJECT-PLAN.md §10.1 (validation) and §10.8 (diagnosis).
 *
 * Design rule: nothing here knows whether bytes came from the network or from
 * a saved fixture.  That is what lets a fix be verified against a site that is
 * currently broken, without calling it (§10.8 requirement 4).
 */

/** How bytes are obtained. Swappable: real HTTP, or a fixture on disk. */
export interface Transport {
  get(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpRequest {
  readonly url: string;
  /** Invesco returns 406 without origin + sec-fetch-*; HSBC needs a referer. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * The three outcomes.  §10.1
 *
 * The distinction between `unavailable` and `suspect` is the important one:
 * being offline must not discard a refresh, but being lied to must.
 */
export type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'suspect'; readonly failure: ValidationFailure };

export interface ValidationFailure {
  /** Which check failed — e.g. 'weights-sum'. */
  readonly check: string;
  /** What was expected, in words: 'weights sum to 99–101%'. */
  readonly expected: string;
  /** What was actually seen: 'summed to 62.3%'. */
  readonly observed: string;
}

/** A check run BEFORE anything is stored. Returns null when it passes. */
export interface Check<T> {
  readonly name: string;
  run(parsed: T): ValidationFailure | null;
}

/** Everything needed to read one website. One file per source (§10.8). */
export interface Source<T> {
  readonly id: string;
  /** Is this source required for the snapshot, or optional? §10.1 */
  readonly core: boolean;
  request(key: string): HttpRequest;
  parse(response: HttpResponse): T;
  readonly checks: readonly Check<T>[];
}
