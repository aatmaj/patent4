import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope } from '../src/lib/orchestrator/validate.js';
import { assertReadOnlySelect, repairJson } from '../src/lib/agents/patentFto.js';
import { stripUngrounded } from '../src/lib/agents/documentReason.js';

function validEnvelope() {
  return {
    executiveSummary: {
      status: 'REVIEW',
      rationale: 'x',
      patentExpiry: { date: '2041-02-17', termSettingDate: '2021-02-17', basis: 'original' },
    },
    ftoRiskMap: { coreStructure: { risk: 'HIGH', sourceRefs: [] } },
    designCorridors: [
      {
        parameter: 'pH', lowerBound: 7, upperBound: 7.8, unit: 'pH units',
        zoneType: 'PERMITTED', evidenceClass: 'U2', sourceRefs: [],
      },
    ],
    constraintsForDOE: [
      { type: 'REQUIREMENT', description: 'x', evidenceClass: 'U2', sourceRefs: [] },
    ],
    verification: Object.fromEntries(
      [
        'phase0_normalize', 'phase1_fto', 'phase2_physchem',
        'phase3_crossDomainFusion', 'phase4_envelopeAdaptation',
        'phase5_emit', 'phase6_selfVerify',
      ].map((p) => [p, { status: 'PASS', conflicts: [] }]),
    ),
  };
}

test('a well-formed envelope validates', () => {
  assert.deepEqual(validateEnvelope(validEnvelope()), []);
});

test('a renamed patentExpiry field is caught', () => {
  // This shape passed the old five-key check and then rendered as "unknown",
  // discarding the date the model had produced.
  const env = validEnvelope();
  env.executiveSummary.patentExpiry = {
    earliestCoreStructureExpiry: 'unknown',
    latestFormulationExpiry: '2041-02-17',
    termSettingPatent: 'US-11318191-B2',
    basis: 'unknown',
  };
  const errors = validateEnvelope(env);
  assert.ok(errors.some((e) => /patentExpiry\.date is required/.test(e)));
});

test('string bounds are rejected', () => {
  const env = validEnvelope();
  env.designCorridors[0].lowerBound = '7.0';
  const errors = validateEnvelope(env);
  assert.ok(errors.some((e) => /must be a JSON number/.test(e)));
});

test('inverted bounds are rejected', () => {
  const env = validEnvelope();
  env.designCorridors[0].lowerBound = 9;
  env.designCorridors[0].upperBound = 7;
  assert.ok(validateEnvelope(env).some((e) => /exceeds upperBound/.test(e)));
});

test('an S1 corridor is rejected at validation time', () => {
  const env = validEnvelope();
  env.designCorridors[0].evidenceClass = 'S1';
  assert.ok(validateEnvelope(env).some((e) => /cannot be S1/.test(e)));
});

test('a missing verification phase is caught by exact key', () => {
  const env = validEnvelope();
  delete env.verification.phase3_crossDomainFusion;
  assert.ok(validateEnvelope(env).some((e) => /phase3_crossDomainFusion is required/.test(e)));
});

test('a bad status enum is caught', () => {
  const env = validEnvelope();
  env.executiveSummary.status = 'MAYBE';
  assert.ok(validateEnvelope(env).some((e) => /executiveSummary\.status must be/.test(e)));
});

test('a risk value with no recognisable level is caught', () => {
  const env = validEnvelope();
  env.ftoRiskMap.coreStructure.risk = 'quite bad actually';
  assert.ok(validateEnvelope(env).some((e) => /must state one of/.test(e)));
});

test('assertReadOnlySelect refuses non-read statements', () => {
  assert.ok(assertReadOnlySelect('SELECT 1 FROM t'));
  assert.ok(assertReadOnlySelect('WITH a AS (SELECT 1) SELECT * FROM a'));
  assert.ok(assertReadOnlySelect('SELECT 1 FROM t;'));

  for (const bad of [
    'DROP TABLE t',
    'SELECT 1; DROP TABLE t',
    'DELETE FROM t WHERE 1=1',
    'CREATE TABLE x AS SELECT 1',
    'EXPORT DATA OPTIONS(uri="gs://x") AS SELECT 1',
  ]) {
    assert.throws(() => assertReadOnlySelect(bad), /refused/, `should refuse: ${bad}`);
  }
});

test('assertReadOnlySelect does not misfire on keywords inside string literals', () => {
  assert.ok(assertReadOnlySelect("SELECT 1 FROM t WHERE title LIKE '%drop delivery%'"));
});

test('repairJson closes brackets in the correct order', () => {
  assert.deepEqual(JSON.parse(repairJson('{"a": [1, 2')), { a: [1, 2] });
  assert.deepEqual(JSON.parse(repairJson('```json\n{"a": {"b": 1},}\n```')), { a: { b: 1 } });
  assert.deepEqual(JSON.parse(repairJson('{"a": [{"b": 1')), { a: [{ b: 1 }] });
});

test('stripUngrounded nulls ungrounded values instead of deleting the key', () => {
  const source = 'The composition comprises phenol at 0.55% w/w.';
  const { value, stripped } = stripUngrounded(
    { phenolLimit: '0.55% w/w', naClRange: '8.2 mg/mL', apiSpecified: 'semaglutide' },
    source,
  );
  assert.equal(value.phenolLimit, '0.55% w/w');
  assert.equal(value.naClRange, null, 'ungrounded value becomes null');
  assert.ok('naClRange' in value, 'the key must survive so the schema stays intact');
  assert.equal(value.apiSpecified, 'semaglutide');
  assert.equal(stripped.length, 1);
  assert.match(stripped[0].path, /naClRange/);
});

test('stripUngrounded requires digit boundaries, not substring matches', () => {
  // "5" appears inside "0.55" but is not itself a value in the source.
  const { value } = stripUngrounded({ v: '5 mg' }, 'phenol at 0.55% w/w');
  assert.equal(value.v, null);
});

test('stripUngrounded preserves array positions', () => {
  const { value } = stripUngrounded(
    { limits: ['0.55%', '9.9%'] },
    'phenol at 0.55% w/w',
  );
  assert.deepEqual(value.limits, ['0.55%', null]);
});
