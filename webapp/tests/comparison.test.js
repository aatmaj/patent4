import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arithmetic } from '../src/lib/agents/arithmetic.js';
import { toCanonical, alignUnits, dimensionOf, DIMENSION } from '../src/lib/units.js';
import { applyHarness } from '../src/lib/orchestrator/harness.js';

/* ── unit normalisation ────────────────────────────────────────────────── */

test('concentrations normalise to mg/mL across notations', () => {
  assert.equal(toCanonical(5.5, 'mg/mL').value, 5.5);
  assert.equal(toCanonical(0.55, '% w/v').value, 5.5, '0.55% w/v is 5.5 mg/mL');
  assert.equal(toCanonical(5.5, 'g/L').value, 5.5);
  assert.equal(toCanonical(5500, 'mcg/mL').value, 5.5);
});

test('% w/w is its own dimension, not silently equated with % w/v', () => {
  // Two mass fractions compare fine; converting one to a concentration assumes
  // a density of exactly 1 g/mL, which is how a claim gets misread.
  assert.equal(dimensionOf('% w/w'), DIMENSION.MASS_FRACTION);
  assert.ok(toCanonical(0.1, '% w/w').ok, 'usable against another mass fraction');

  const crossBasis = alignUnits([
    { value: 5.5, unit: 'mg/mL', label: 'label' },
    { value: 0.1, unit: '% w/w', label: 'claim' },
  ]);
  assert.equal(crossBasis.ok, false);
  assert.match(crossBasis.reason, /density/);

  const sameBasis = alignUnits([
    { value: 15, unit: '% w/w' },
    { value: 50, unit: '% w/w' },
  ]);
  assert.ok(sameBasis.ok, 'mass fraction vs mass fraction is a valid comparison');
});

test('cross-dimension comparison is refused', () => {
  const out = alignUnits([
    { value: 5, unit: 'mg/mL', label: 'a' },
    { value: 5, unit: 'mg', label: 'b' },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /dimensions/);
});

test('dimensionless units only compare when they agree', () => {
  assert.ok(alignUnits([{ value: 7.4, unit: 'pH' }, { value: 7.8, unit: 'pH' }]).ok);
  const mixed = alignUnits([{ value: 7.4, unit: 'pH' }, { value: 7.8, unit: 'count' }]);
  assert.equal(mixed.ok, false);
});

/* ── in_range: the operation that decides claim coverage ───────────────── */

test('in_range answers claim coverage across units', () => {
  // The real question from run 1: a claim caps phenol at 0.1% (w/v); the RLD
  // label states 5.5 mg/mL. Does the RLD fall inside the claim?
  const out = arithmetic({
    operation: 'in_range',
    params: { value: 5.5, valueUnit: 'mg/mL', lower: 0, upper: 0.1, lowerUnit: '% w/v', upperUnit: '% w/v' },
  });
  assert.equal(out.result, false);
  assert.equal(out.relation, 'above');
  assert.equal(out.normalized.upper, 1, '0.1% w/v is 1 mg/mL');
  assert.equal(out.evidenceClass, 'S2');
});

test('in_range reports within / below / above', () => {
  const p = (value) => arithmetic({ operation: 'in_range', params: { value, lower: 7, upper: 7.8, unit: 'pH' } });
  assert.equal(p(7.4).relation, 'within');
  assert.equal(p(6.5).relation, 'below');
  assert.equal(p(8.2).relation, 'above');
});

test('in_range honours exclusive bounds', () => {
  const base = { value: 7, lower: 7, upper: 8, unit: 'pH' };
  assert.equal(arithmetic({ operation: 'in_range', params: base }).result, true);
  assert.equal(
    arithmetic({ operation: 'in_range', params: { ...base, lowerInclusive: false } }).result,
    false,
  );
});

test('in_range accepts a one-sided bound', () => {
  const out = arithmetic({
    operation: 'in_range',
    params: { value: 60, lower: 50, upper: null, unit: '%' },
  });
  assert.equal(out.result, true);
});

test('in_range refuses rather than guessing when units cannot align', () => {
  assert.throws(
    () =>
      arithmetic({
        operation: 'in_range',
        params: { value: 5.5, valueUnit: 'mg/mL', lower: 0, upper: 0.1, lowerUnit: '% w/w', upperUnit: '% w/w' },
      }),
    /density/,
  );
});

test('in_range requires a value and at least one bound', () => {
  assert.throws(() => arithmetic({ operation: 'in_range', params: { value: 1 } }), /lower.*upper/);
  assert.throws(
    () => arithmetic({ operation: 'in_range', params: { lower: 1, upper: 2 } }),
    /finite numeric/,
  );
});

/* ── compare and overlap ───────────────────────────────────────────────── */

test('compare normalises before ordering', () => {
  const out = arithmetic({
    operation: 'compare',
    params: { a: 0.55, aUnit: '% w/v', b: 5.5, bUnit: 'mg/mL' },
  });
  assert.equal(out.relation, 'eq', '0.55% w/v equals 5.5 mg/mL');
});

test('overlap decides whether a product range touches a claimed range', () => {
  const disjoint = arithmetic({
    operation: 'overlap',
    params: { aLower: 0.5, aUpper: 0.6, bLower: 0, bUpper: 0.1, unit: '% w/v' },
  });
  assert.equal(disjoint.result, false);
  assert.equal(disjoint.intersection, null);

  const touching = arithmetic({
    operation: 'overlap',
    params: { aLower: 0.05, aUpper: 0.6, bLower: 0, bUpper: 0.1, unit: '% w/v' },
  });
  assert.equal(touching.result, true);
  assert.deepEqual(touching.intersection, { lower: 0.5, upper: 1, unit: 'mg/mL' });
});

test('an open-ended claim range is handled', () => {
  const out = arithmetic({
    operation: 'overlap',
    params: { aLower: 60, aUpper: null, bLower: 50, bUpper: null, unit: '%' },
  });
  assert.equal(out.result, true);
});

/* ── harness rule 11: the logic auditor ────────────────────────────────── */

const PHASES = [
  'phase0_normalize', 'phase1_fto', 'phase2_physchem',
  'phase3_crossDomainFusion', 'phase4_envelopeAdaptation',
  'phase5_emit', 'phase6_selfVerify',
];

function envelope(corridors) {
  return {
    targetProduct: { molecule: 'X', dosageForm: 'Tablet', regulatoryPathway: 'NDA' },
    executiveSummary: { status: 'REVIEW', rationale: '' },
    ftoRiskMap: {},
    designCorridors: corridors,
    constraintsForDOE: [],
    openQuestions: [],
    verification: Object.fromEntries(PHASES.map((p) => [p, { status: 'PASS', conflicts: [] }])),
  };
}

const BOUNDED = [
  {
    parameter: 'Phenol concentration',
    lowerBound: 0.5,
    upperBound: 0.6,
    unit: '% w/v',
    zoneType: 'EXCLUDED',
    evidenceClass: 'U2',
    sourceRefs: [],
  },
];

test('a bounded corridor with no comparison behind it fails verification', () => {
  // This is the gap: for 16 runs a containment verdict could be asserted in
  // prose and nothing checked it.
  const env = envelope(structuredClone(BOUNDED));
  const { blocking } = applyHarness(env, [], { today: '2026-08-14' });

  assert.equal(env.designCorridors[0].numericBacking, 'unverified');
  assert.ok(blocking.some((b) => /no in_range\/compare\/overlap call/.test(b)));
  assert.equal(env.verification.phase6_selfVerify.status, 'FAIL');
});

test('a bounded corridor backed by a real comparison passes', () => {
  const env = envelope(structuredClone(BOUNDED));
  const comparison = arithmetic({
    operation: 'in_range',
    params: { value: 0.55, lower: 0.5, upper: 0.6, unit: '% w/v' },
  });

  const { blocking } = applyHarness(
    env,
    [{ tool: 'arithmetic', input: { operation: 'in_range' }, status: 'success', output: comparison }],
    { today: '2026-08-14' },
  );

  assert.equal(env.designCorridors[0].numericBacking, 'verified');
  assert.deepEqual(blocking, []);
  assert.equal(env.verification.phase6_selfVerify.status, 'PASS');
});

test('a comparison over unrelated numbers does not count as backing', () => {
  const env = envelope(structuredClone(BOUNDED));
  const unrelated = arithmetic({
    operation: 'in_range',
    params: { value: 42, lower: 40, upper: 50, unit: '%' },
  });
  const { blocking } = applyHarness(
    env,
    [{ tool: 'arithmetic', input: { operation: 'in_range' }, status: 'success', output: unrelated }],
    { today: '2026-08-14' },
  );
  assert.equal(env.designCorridors[0].numericBacking, 'unverified');
  assert.equal(blocking.length, 1);
});

test('a non-comparison arithmetic call does not count as backing', () => {
  // patent_expiry and earliest were the only operations ever called; neither
  // says anything about containment.
  const env = envelope(structuredClone(BOUNDED));
  const expiry = arithmetic({ operation: 'patent_expiry', params: { filingDate: '2000-01-01' } });
  const { blocking } = applyHarness(
    env,
    [{ tool: 'arithmetic', input: { operation: 'patent_expiry' }, status: 'success', output: expiry }],
    { today: '2026-08-14' },
  );
  assert.equal(blocking.length, 1);
});

test('a corridor with no numeric bounds needs no comparison', () => {
  const env = envelope([
    { parameter: 'Buffer identity', zoneType: 'PERMITTED', evidenceClass: 'U2', sourceRefs: [] },
  ]);
  const { blocking } = applyHarness(env, [], { today: '2026-08-14' });
  assert.deepEqual(blocking, []);
});
