import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, add, scale, sum, penceToPounds, format } from './money.ts';

test('adds same currency', () => {
  assert.equal(add(money(10, 'GBP'), money(5, 'GBP')).amount, 15);
});

test('refuses to add different currencies at runtime', () => {
  const gbp = money(10, 'GBP');
  const usd = money(10, 'USD') as unknown as typeof gbp;   // simulate untyped caller
  assert.throws(() => add(gbp, usd), /Cannot add USD to GBP/);
});

test('pence to pounds is a denomination change, not an FX conversion', () => {
  const lsePrice = money(2_847.5, 'GBp');       // Shell quoted on the LSE
  assert.equal(penceToPounds(lsePrice).amount, 28.475);
});

test('format makes pence visibly different from pounds', () => {
  assert.equal(format(money(2847.5, 'GBp')), '2847.50p');
  assert.equal(format(money(28.475, 'GBP')), '£28.48');
});

test('scale handles fund weights', () => {
  const fundValue = money(1000, 'GBP');
  assert.equal(scale(fundValue, 0.0568).amount.toFixed(2), '56.80');   // 5.68% weight
});

test('sum of an empty list is zero in the stated currency', () => {
  assert.equal(sum([], 'GBP').amount, 0);
});

test('rejects non-finite amounts', () => {
  assert.throws(() => money(NaN, 'GBP'), TypeError);
  assert.throws(() => money(Infinity, 'USD'), TypeError);
});
