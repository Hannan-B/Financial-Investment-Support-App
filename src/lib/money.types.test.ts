/**
 * Compile-time regression test for the Money type.  PROJECT-PLAN.md §7④
 *
 * This caught a real bug: without `NoInfer`, TypeScript widened the type
 * parameter to `'GBP' | 'USD'` and happily accepted a currency mismatch — the
 * exact thing the type existed to prevent. A runtime test cannot catch that,
 * so this drives the compiler directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Type-checks a snippet against the real money.ts. Returns compiler output. */
function typecheck(snippet: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-'));
  const file = join(dir, 'snippet.ts');
  const moneyPath = join(REPO, 'src', 'lib', 'money.ts').replaceAll('\\', '/');
  writeFileSync(file, snippet.replace('__MONEY__', moneyPath));
  try {
    execFileSync('npx', ['tsc', '--noEmit', '--strict', '--target', 'es2022',
      '--module', 'esnext', '--moduleResolution', 'bundler',
      '--allowImportingTsExtensions', file], { cwd: REPO, encoding: 'utf8' });
    return { ok: true, output: '' };
  } catch (e) {
    const err = e as { stdout?: string };
    return { ok: false, output: err.stdout ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('adding GBP to USD must FAIL to compile', () => {
  const r = typecheck(`
    import { money, add } from '__MONEY__';
    add(money(10, 'GBP'), money(5, 'USD'));
  `);
  assert.equal(r.ok, false, 'a currency mismatch must not compile');
  assert.match(r.output, /not assignable/);
});

test('pence and pounds are different currencies', () => {
  const r = typecheck(`
    import { money, add } from '__MONEY__';
    add(money(10, 'GBP'), money(500, 'GBp'));
  `);
  assert.equal(r.ok, false, 'GBp must not be accepted where GBP is required');
});

test('matching currencies still compile', () => {
  const r = typecheck(`
    import { money, add, scale, penceToPounds } from '__MONEY__';
    add(money(10, 'GBP'), money(5, 'GBP'));
    add(penceToPounds(money(2847.5, 'GBp')), money(5, 'GBP'));
    scale(money(1000, 'GBP'), 0.0568);
  `);
  assert.equal(r.ok, true, `correct usage must compile:\n${r.output}`);
});
