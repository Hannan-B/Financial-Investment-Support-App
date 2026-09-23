import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { toBase64, fromBase64 } from './base64.ts';

test('every byte value survives the round trip', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64(toBase64(all)), all);
});

test('matches Node’s own encoder', () => {
  const bytes = new TextEncoder().encode('Invesco 406 ≠ 429');
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('a real binary fixture larger than one chunk survives intact', async () => {
  const xls = new Uint8Array(await readFile(fileURLToPath(new URL('../fetch/fixtures/hsbc-hies.xls', import.meta.url))));
  assert.ok(xls.length > 0x8000, 'fixture should span several chunks');
  assert.deepEqual(fromBase64(toBase64(xls)), xls);
});
