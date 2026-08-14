import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arithmetic } from '../src/lib/agents/arithmetic.js';

test('patent_expiry accepts the BigQuery YYYYMMDD filing date', () => {
  const out = arithmetic({
    operation: 'patent_expiry',
    params: { filingDate: 20150612 },
  });
  assert.equal(out.result, '2035-06-12');
  assert.equal(out.evidenceClass, 'S2');
});

test('patent_expiry does not silently produce a 1970-based date', () => {
  const out = arithmetic({ operation: 'patent_expiry', params: { filing_date: 20150612 } });
  assert.ok(out.result.startsWith('2035'), `expected 2035, got ${out.result}`);
});

test('patent_expiry rejects an uninterpretable filing date instead of guessing', () => {
  assert.throws(
    () => arithmetic({
      operation: 'patent_expiry',
      params: { filingDate: 'MISSING_FILING_DATE_EXPIRY_UNKNOWN' },
    }),
    /Could not interpret filingDate/,
  );
});

test('patent_expiry requires a filing date', () => {
  assert.throws(
    () => arithmetic({ operation: 'patent_expiry', params: {} }),
    /filingDate is required/,
  );
});

test('patent_expiry caps PTE at exactly five calendar years', () => {
  const out = arithmetic({
    operation: 'patent_expiry',
    params: { filingDate: '2000-01-01', pte_days: 3650 }, // 10 years requested
  });
  assert.ok(out.notes.some((n) => /statutory cap/.test(n)));
  // 2000-01-01 + 20y = 2020-01-01; + 5 calendar years = 2025-01-01 exactly.
  assert.equal(out.result, '2025-01-01');
});

test('patent_expiry leaves a within-cap PTE unmodified', () => {
  const out = arithmetic({
    operation: 'patent_expiry',
    params: { filingDate: '2000-01-01', patent_term_extension_days: 500 },
  });
  assert.deepEqual(out.notes, []);
  assert.equal(out.result, '2021-05-15');
  // 2020-01-01 -> 2025-01-01 spans two leap days, so the calendar-exact cap
  // is 1827 days rather than a flat 5 x 365.25.
  assert.equal(out.inputs.maxPteDays, 1827);
});

test('patent_expiry adds PTA in days and pediatric exclusivity in months', () => {
  const base = arithmetic({ operation: 'patent_expiry', params: { filingDate: '2000-01-01' } });
  const withPta = arithmetic({
    operation: 'patent_expiry',
    params: { filingDate: '2000-01-01', pta_days: 100 },
  });
  const withPed = arithmetic({
    operation: 'patent_expiry',
    params: { filingDate: '2000-01-01', pediatric: true },
  });
  assert.equal(base.result, '2020-01-01');
  assert.equal(withPta.result, '2020-04-10');
  assert.equal(withPed.result, '2020-07-01', 'six calendar months, not 182.6 days');
});

test('eval refuses anything outside arithmetic characters', () => {
  assert.equal(arithmetic({ operation: 'eval', params: { expression: '2 + 3 * 4' } }).result, 14);
  for (const bad of [
    'process.exit(1)',
    'globalThis',
    '1;require("fs")',
    'this.constructor',
    '`${1}`',
  ]) {
    assert.throws(
      () => arithmetic({ operation: 'eval', params: { expression: bad } }),
      /refused for safety|too long/,
      `expected refusal for: ${bad}`,
    );
  }
});

test('eval rejects non-finite results', () => {
  assert.throws(
    () => arithmetic({ operation: 'eval', params: { expression: '1/0' } }),
    /finite number/,
  );
});

test('unit_convert validates its inputs', () => {
  assert.equal(arithmetic({ operation: 'unit_convert', params: { value: 5, from: 'mg', to: 'g' } }).result, 0.005);
  assert.throws(
    () => arithmetic({ operation: 'unit_convert', params: { value: 5, from: 'mg', to: 'furlong' } }),
    /Unknown conversion/,
  );
});

test('unknown operations name the supported set', () => {
  assert.throws(() => arithmetic({ operation: 'nope', params: {} }), /Expected one of/);
});
