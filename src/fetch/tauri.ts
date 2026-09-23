/**
 * The real network and the real diagnostics folder, both through Rust.
 * Tests use `fixture.ts` instead; nothing else can tell the difference.
 */
import { invoke } from '@tauri-apps/api/core';
import type { Transport, HttpRequest, HttpResponse, ParseTools } from './types.ts';
import { extensionFor, type Diagnostics, type FailureLogEntry } from './diagnostics.ts';
import { fromBase64, toBase64 } from '../lib/base64.ts';

interface RustResponse { status: number; body_base64: string; content_type: string; }

/** HTTP via Rust, which can set the headers browsers forbid (§8). */
export class TauriTransport implements Transport {
  async get(request: HttpRequest): Promise<HttpResponse> {
    const res = await invoke<RustResponse>('fetch_url', {
      request: { url: request.url, headers: request.headers ?? {} },
    });
    return { status: res.status, body: fromBase64(res.body_base64), contentType: res.content_type };
  }
}

/** `<app data>/diagnostics/` — see `src-tauri/src/diagnostics.rs`. */
export class TauriDiagnostics implements Diagnostics {
  saveResponse(source: string, which: 'last-good' | 'last-failed', response: HttpResponse): Promise<string> {
    return invoke<string>('diagnostics_save', {
      source,
      which,
      extension: extensionFor(response.contentType),
      bodyBase64: toBase64(response.body),
    });
  }

  appendLog(entry: FailureLogEntry): Promise<void> {
    return invoke('diagnostics_log', { line: JSON.stringify(entry) });
  }
}

/** Decoders that need Rust — HSBC's legacy .xls (§4.2). */
export const tauriTools: ParseTools = {
  xlsRows: (bytes) => invoke<string[][]>('parse_xls', { bytesBase64: toBase64(bytes) }),
};

/**
 * Trading 212 via Rust, which holds the key and allows only its read-only
 * list of paths. `request.url` is a path, e.g. '/api/v0/equity/positions'.
 */
export class T212Transport implements Transport {
  async get(request: HttpRequest): Promise<HttpResponse> {
    const res = await invoke<RustResponse>('t212_get', { path: request.url });
    return { status: res.status, body: fromBase64(res.body_base64), contentType: res.content_type };
  }
}

/** The key goes straight to the macOS keychain; it can never be read back. */
export const t212Key = {
  saved: () => invoke<boolean>('t212_key_saved'),
  save: (key: string, secret: string) => invoke<void>('t212_key_save', { key, secret }),
  remove: () => invoke<void>('t212_key_delete'),
};
