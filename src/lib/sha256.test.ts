/**
 * SHA-256 against the standard test vectors and Node's own implementation,
 * and the compression and hex round trips raw responses depend on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256 } from './sha256.ts';
import { gzip, gunzip, toHex, fromHex } from './gzip.ts';
import { NodeDb } from '../db/node.ts';

const text = (s: string) => new TextEncoder().encode(s);

test('SHA-256: the standard test vectors', () => {
  assert.equal(sha256(text('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256(text('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256(text('a'.repeat(1_000_000))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 agrees with Node’s at every length around the block boundaries', () => {
  for (let n = 0; n <= 200; n++) {
    const bytes = new Uint8Array(randomBytes(n));
    assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'), `length ${n}`);
  }
});

test('gzip round trip', async () => {
  const bytes = new Uint8Array(randomBytes(5000));
  assert.deepEqual(await gunzip(await gzip(bytes)), bytes);
  assert.deepEqual(await gunzip(await gzip(new Uint8Array())), new Uint8Array());
});

test('bytes survive the trip through SQLite as hex', async () => {
  const bytes = new Uint8Array(randomBytes(300));
  assert.deepEqual(fromHex(toHex(bytes)), bytes);
  const db = new NodeDb();
  await db.query('CREATE TABLE t (b BLOB)');
  await db.query('INSERT INTO t VALUES (unhex(?))', [toHex(bytes)]);
  const [row] = await db.query('SELECT hex(b) AS h, typeof(b) AS kind, length(b) AS n FROM t');
  assert.equal(row!['kind'], 'blob', 'stored as bytes, not as text');
  assert.equal(row!['n'], 300);
  assert.deepEqual(fromHex(String(row!['h'])), bytes);
  assert.throws(() => fromHex('abc'));
});
