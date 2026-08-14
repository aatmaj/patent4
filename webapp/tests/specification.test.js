import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHarness, propagateFailures } from '../src/lib/orchestrator/harness.js';
import {
  selectDeliverable,
  isDegenerate,
  DELIVERABLE,
} from '../src/lib/orchestrator/specification.js';
import { arithmetic } from '../src/lib/agents/arithmetic.js';

const TODAY = '2026-08-14';
const PHASES = [
  'phase0_normalize', 'phase1_fto', 'phase2_physchem',
  'phase3_crossDomainFusion', 'phase4_envelopeAdaptation',
  'phase5_emit', 'phase6_selfVerify',
];

function envelope(overrides = {}) {
  return {
    targetProduct: {
      molecule: 'Semaglutide',
      dosageForm: 'Injection (subcutaneous)',
      regulatoryPathway: 'ANDA 505(j)',
      strength: '1 mg/mL',
    },
    executiveSummary: { status: 'REVIEW', rationale: '', patentExpiry: { date: 'unknown', basis: 'unknown' } },
    ftoRiskMap: {},
    designCorridors: [],
    constraintsForDOE: [],
    verification: Object.fromEntries(PHASES.map((p) => [p, { status: 'PASS', conflicts: [] }])),
    openQuestions: [],
    ...overrides,
  };
}

const RLD_OUTPUT = {
  rld: { brandName: 'Ozempic', applicationNumber: 'NDA209637', genericName: 'semaglutide' },
  pH: { value: 7.4, raw: 'pH of approximately 7.4' },
  presentations: [
    {
      label: '0.5 mg/0.5 mL', concentrationMgPerMl: 1, context: 'single-dose presentation',
      composition: {
        basis: '1 mL', context: 'single-dose presentation',
        ingredients: [
          { name: 'disodium phosphate dihydrate', amount: 1.42, unit: 'mg' },
          { name: 'sodium chloride', amount: 8.25, unit: 'mg' },
        ],
      },
    },
    {
      label: '4 mg/3 mL', concentrationMgPerMl: 4 / 3, context: 'multi-dose pen presentation',
      composition: {
        basis: '1 mL', context: 'multi-dose pen presentation',
        ingredients: [
          { name: 'disodium phosphate dihydrate', amount: 1.42, unit: 'mg' },
          { name: 'propylene glycol', amount: 14, unit: 'mg' },
          { name: 'phenol', amount: 5.5, unit: 'mg' },
        ],
      },
    },
  ],
  compositions: [],
};

const rldTool = { tool: 'rld_profile', status: 'success', output: RLD_OUTPUT };

/* ── deliverable selection ─────────────────────────────────────────────── */

test('a 505(j) parenteral has zero formulation design freedom', () => {
  const d = selectDeliverable({ regulatoryPathway: 'ANDA 505(j)', dosageForm: 'Injection' });
  assert.equal(d.type, DELIVERABLE.RLD_MATCHED_SPECIFICATION);
  assert.equal(d.designFreedom, 'none');
});

test('a 505(j) solid oral keeps corridors', () => {
  const d = selectDeliverable({ regulatoryPathway: 'ANDA 505(j)', dosageForm: 'Tablet' });
  assert.equal(d.type, DELIVERABLE.DESIGN_CORRIDORS);
  assert.equal(d.designFreedom, 'limited');
});

test('505(b)(2) and NDA keep corridors with full freedom', () => {
  for (const pathway of ['505(b)(2)', 'NDA']) {
    const d = selectDeliverable({ regulatoryPathway: pathway, dosageForm: 'Injection' });
    assert.equal(d.type, DELIVERABLE.DESIGN_CORRIDORS, pathway);
    assert.equal(d.designFreedom, 'full', pathway);
  }
});

test('a zero-width or unbounded corridor carries no design information', () => {
  assert.ok(isDegenerate({ lowerBound: 1.34, upperBound: 1.34 }));
  assert.ok(isDegenerate({ lowerBound: null, upperBound: null }));
  assert.ok(!isDegenerate({ lowerBound: 7.0, upperBound: 7.8 }));
});

/* ── specification mode ────────────────────────────────────────────────── */

test('degenerate corridors are replaced by an RLD specification', () => {
  const env = envelope({
    designCorridors: [
      { parameter: 'Phenol', lowerBound: null, upperBound: null, zoneType: 'PERMITTED', rldMatched: true, evidenceClass: 'U2', sourceRefs: [] },
      { parameter: 'Disodium phosphate', lowerBound: null, upperBound: null, zoneType: 'PERMITTED', rldMatched: true, evidenceClass: 'U2', sourceRefs: [] },
      { parameter: 'Semaglutide concentration', lowerBound: 1, upperBound: 1, zoneType: 'PERMITTED', evidenceClass: 'U2', sourceRefs: [] },
    ],
  });

  const { advisory } = applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });

  assert.equal(env.deliverable.type, DELIVERABLE.RLD_MATCHED_SPECIFICATION);
  assert.deepEqual(env.designCorridors, [], 'zero-width corridors must not survive as a fake design space');
  assert.ok(env.rldSpecification, 'a specification replaces them');
  assert.equal(env.rldSpecification.referenceListedDrug.applicationNumber, 'NDA209637');
  assert.ok(advisory.some((a) => /zero width/.test(a)));
});

test('the specification uses the composition of the resolved presentation', () => {
  const env = envelope();
  applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });

  const names = env.rldSpecification.excipients.map((e) => e.name);
  // 1 mg/mL is the single-dose syringe: sodium chloride, no preservative.
  assert.ok(names.includes('sodium chloride'));
  assert.ok(!names.includes('phenol'), 'the pen’s preservative is not in the syringe');
  assert.equal(env.rldSpecification.pH.target, 7.4);
  assert.equal(env.rldSpecification.activeIngredient.target, 1);
});

test('a different requested strength selects a different composition', () => {
  const env = envelope({
    targetProduct: { ...envelope().targetProduct, strength: '1.34 mg/mL' },
  });
  applyHarness(env, [rldTool], { today: TODAY, strength: '1.34 mg/mL' });

  const names = env.rldSpecification.excipients.map((e) => e.name);
  assert.ok(names.includes('phenol'), 'the multi-dose pen is preserved');
  assert.ok(names.includes('propylene glycol'));
});

test('the specification names the development work that actually remains', () => {
  const env = envelope();
  applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });
  const program = env.rldSpecification.developmentProgram;
  assert.ok(program.analytical.length > 0);
  assert.ok(program.stability.length > 0);
  assert.ok(program.openToDesign.some((s) => /process/i.test(s)));
});

test('with no RLD composition the specification is refused, not invented', () => {
  const env = envelope({
    designCorridors: [
      { parameter: 'Phenol', lowerBound: null, upperBound: null, zoneType: 'PERMITTED', evidenceClass: 'U2', sourceRefs: [] },
    ],
  });
  const { blocking } = applyHarness(env, [], { today: TODAY });
  assert.equal(env.rldSpecification, undefined);
  assert.ok(blocking.some((b) => /specification is UNKNOWN/.test(b)));
  assert.equal(env.verification.phase6_selfVerify.status, 'FAIL');
});

/* ── strength resolution ───────────────────────────────────────────────── */

test('a strength matching no presentation blocks rather than substituting', () => {
  const env = envelope({ targetProduct: { ...envelope().targetProduct, strength: '7 mg/mL' } });
  const { blocking } = applyHarness(env, [rldTool], { today: TODAY, strength: '7 mg/mL' });
  assert.equal(env.strengthResolution.status, 'NO_MATCH');
  assert.ok(blocking.some((b) => /does not correspond to any RLD presentation/.test(b)));
});

test('a silent presentation substitution is caught', () => {
  // Requested 1 mg/mL (syringe) but the envelope states 1.34 mg/mL (pen) —
  // different composition, different Q1/Q2 target.
  const env = envelope({
    targetProduct: { ...envelope().targetProduct, strength: '1.34 mg/mL' },
  });
  const { blocking } = applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });
  assert.ok(blocking.some((b) => /is not the requested strength/.test(b)));
});

test('a matching strength records the resolved presentation', () => {
  const env = envelope();
  applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });
  assert.equal(env.strengthResolution.status, 'MATCH');
  assert.equal(env.targetProduct.resolvedPresentation, '0.5 mg/0.5 mL');
  assert.equal(env.targetProduct.presentationContext, 'single-dose presentation');
});

/* ── phase propagation ─────────────────────────────────────────────────── */

test('a phase-1 failure reaches fusion, adaptation and emit', () => {
  // Previously only phase 6 consumed upstream failures, so phase 3 could report
  // "cross-domain fusion: PASS" having fused nothing.
  const env = envelope();
  env.verification.phase1_fto.status = 'FAIL';
  propagateFailures(env);

  assert.equal(env.verification.phase3_crossDomainFusion.status, 'FAIL');
  assert.equal(env.verification.phase4_envelopeAdaptation.status, 'FAIL');
  assert.equal(env.verification.phase5_emit.status, 'FAIL');
  assert.match(env.verification.phase3_crossDomainFusion.conflicts.join(' '), /depends on/);
});

test('propagation runs through the harness and fails phase 6', () => {
  const env = envelope();
  const toolOutputs = [
    { tool: 'patent_fto_agent', status: 'success', output: { hasParseError: true } },
    rldTool,
  ];
  applyHarness(env, toolOutputs, { today: TODAY, strength: '1 mg/mL' });

  assert.equal(env.verification.phase1_fto.status, 'FAIL');
  assert.equal(env.verification.phase5_emit.status, 'FAIL');
  assert.equal(env.verification.phase6_selfVerify.status, 'FAIL');
});

test('propagation leaves an all-passing envelope alone', () => {
  const env = envelope();
  propagateFailures(env);
  assert.ok(PHASES.every((p) => env.verification[p].status === 'PASS'));
});

/* ── arithmetic aggregation ────────────────────────────────────────────── */

test('earliest and latest work over date lists', () => {
  const dates = ['20340502', '2031-12-16', 20330619];
  assert.equal(arithmetic({ operation: 'earliest', params: { values: dates } }).result, '2031-12-16');
  assert.equal(arithmetic({ operation: 'latest', params: { values: dates } }).result, '2034-05-02');
});

test('min and max work over numbers', () => {
  assert.equal(arithmetic({ operation: 'min', params: { values: [3, 1.5, 9] } }).result, 1.5);
  assert.equal(arithmetic({ operation: 'max', params: { values: [3, 1.5, 9] } }).result, 9);
});

test('earliest refuses a list that is not all dates', () => {
  assert.throws(
    () => arithmetic({ operation: 'earliest', params: { values: ['2031-12-16', 'soon'] } }),
    /requires every value to be a date/,
  );
});

test('aggregation requires a non-empty list', () => {
  assert.throws(() => arithmetic({ operation: 'min', params: {} }), /non-empty/);
  assert.throws(() => arithmetic({ operation: 'min', params: { values: [] } }), /non-empty/);
});

test('eval still refuses list syntax — aggregation has its own operations', () => {
  assert.throws(
    () => arithmetic({ operation: 'eval', params: { expression: 'min([1,2,3])' } }),
    /refused for safety/,
  );
});

/* ── regressions from the 2026-08-14 semaglutide run ───────────────────── */

const RLD_EMPTY = {
  // A brand-name lookup that landed on the wrong product: no presentations.
  rld: { brandName: 'OZEMPIC', applicationNumber: 'NDA213051', route: 'ORAL' },
  presentations: [],
  compositions: [],
};

test('the harness uses the most informative rld_profile call, not the first', () => {
  // The orchestrator retried after a brand lookup hit the oral product. Taking
  // the first success made the harness reason about the discarded attempt and
  // skip strength resolution entirely.
  const env = envelope();
  applyHarness(
    env,
    [
      { tool: 'rld_profile', status: 'success', output: RLD_EMPTY },
      rldTool,
    ],
    { today: TODAY, strength: '1 mg/mL' },
  );

  assert.equal(env.strengthResolution.status, 'MATCH');
  assert.equal(env.strengthResolution.resolvedPresentation.context, 'single-dose presentation');
  assert.ok(env.rldSpecification, 'the good call supplies the specification');
});

test('a U1 value sourced from the RLD label is not demoted', () => {
  // Rule 3 only knew about patent claims, so a label-sourced constraint was
  // demoted for "no cited patent" even though the label was retrieved.
  const env = envelope({
    constraintsForDOE: [
      {
        type: 'REQUIREMENT',
        description: 'Match the RLD composition.',
        evidenceClass: 'U1',
        sourceRefs: ['NDA209637 label (rld_profile)'],
      },
    ],
  });
  applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });
  assert.equal(env.constraintsForDOE[0].evidenceClass, 'U1');
});

test('a U1 value with no retrievable source is still demoted', () => {
  const env = envelope({
    constraintsForDOE: [
      { type: 'REQUIREMENT', description: 'x', evidenceClass: 'U1', sourceRefs: ['21 CFR 314.94'] },
    ],
  });
  const { advisory } = applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });
  assert.equal(env.constraintsForDOE[0].evidenceClass, 'U2');
  assert.ok(advisory.some((a) => /demoted U1 to U2/.test(a)));
});

test('expired patents cited in the risk map are annotated, not left implying a block', () => {
  const env = envelope({
    ftoRiskMap: {
      coreStructure: { risk: 'HIGH', sourceRefs: ['US8536122 (expires 2026-03-20)', 'US8129343'] },
    },
  });
  const toolOutputs = [
    rldTool,
    {
      tool: 'orange_book_agent',
      status: 'success',
      output: {
        patents: [
          { patent_number: '8536122', expiration_date: '20260320' }, // expired
          { patent_number: '8129343', expiration_date: '20311205' }, // live
        ],
      },
    },
  ];
  applyHarness(env, toolOutputs, { today: TODAY, strength: '1 mg/mL' });

  const core = env.ftoRiskMap.coreStructure;
  assert.deepEqual(core.expiredSourceRefs, ['US8536122 (expires 2026-03-20)']);
  assert.match(core.expiryNote, /cannot block/);
});

test('the scope note is not emitted when there is no specification to point at', () => {
  // It referenced rldSpecification.developmentProgram on a null specification.
  const env = envelope();
  applyHarness(env, [], { today: TODAY, strength: '1 mg/mL' });
  assert.equal(env.rldSpecification, undefined);
  assert.ok(!env.openQuestions.some((q) => /developmentProgram/.test(q)));
});

test('the scope note IS emitted once a specification exists', () => {
  const env = envelope();
  applyHarness(env, [rldTool], { today: TODAY, strength: '1 mg/mL' });
  assert.ok(env.rldSpecification);
  assert.ok(env.openQuestions.some((q) => /developmentProgram/.test(q)));
});
