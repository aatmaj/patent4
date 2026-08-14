import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePatentDate, addYears, addDays, toCompact } from '../src/lib/dates.js';

test('normalizePatentDate handles the BigQuery YYYYMMDD integer encoding', () => {
  // The original bug: new Date(20150612) is epoch milliseconds -> 1970-08-21,
  // which produced patent expiries ~55 years early with no error raised.
  assert.equal(normalizePatentDate(20150612), '2015-06-12');
  assert.equal(normalizePatentDate('20150612'), '2015-06-12');
  assert.equal(normalizePatentDate('20340502'), '2034-05-02');
});

test('normalizePatentDate handles ISO and slashed forms', () => {
  assert.equal(normalizePatentDate('2015-06-12'), '2015-06-12');
  assert.equal(normalizePatentDate('2015/6/12'), '2015-06-12');
  assert.equal(normalizePatentDate(new Date('2015-06-12T00:00:00Z')), '2015-06-12');
  assert.equal(normalizePatentDate({ value: '2015-06-12' }), '2015-06-12');
});

test('normalizePatentDate refuses rather than guessing', () => {
  assert.equal(normalizePatentDate(null), null);
  assert.equal(normalizePatentDate(''), null);
  assert.equal(normalizePatentDate('MISSING_FILING_DATE_EXPIRY_UNKNOWN'), null);
  assert.equal(normalizePatentDate('20150230'), null, 'Feb 30 must not roll forward');
  assert.equal(normalizePatentDate('20151312'), null, 'month 13 is invalid');
  assert.equal(normalizePatentDate(12345), null, 'not a plausible date encoding');
});

test('addYears and addDays preserve calendar semantics', () => {
  assert.equal(addYears('2015-06-12', 20), '2035-06-12');
  assert.equal(addDays('2035-06-12', 365), '2036-06-11');
  assert.equal(addDays('2035-06-12', 0), '2035-06-12');
});

test('toCompact round-trips for string comparison against openFDA fields', () => {
  assert.equal(toCompact('2026-08-14'), '20260814');
  assert.equal(toCompact(20260814), '20260814');
  assert.equal(toCompact('nonsense'), null);
});
