import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHarness } from '../src/lib/orchestrator/harness.js';

const TODAY = '2026-08-14';

/**
 * A recorded in_range call covering these bounds.
 *
 * Rule 11 requires every corridor stating numeric bounds to be backed by a
 * comparison over those numbers. These tests are about pathway and evidence
 * logic, so they supply the backing a real run would have and stay focused on
 * their own concern.
 */
function comparisonFor(lower, upper) {
  return {
    tool: 'arithmetic',
    input: { operation: 'in_range' },
    status: 'success',
    output: { normalized: { value: lower, lower, upper }, inputs: { lower, upper } },
  };
}

function baseEnvelope(overrides = {}) {
  return {
    targetProduct: {
      molecule: 'Semaglutide',
      dosageForm: 'Injection (subcutaneous)',
      regulatoryPathway: 'ANDA 505(j)',
    },
    executiveSummary: { status: 'REVIEW', rationale: '', patentExpiry: { date: 'unknown', basis: 'unknown' } },
    ftoRiskMap: {},
    designCorridors: [],
    constraintsForDOE: [],
    verification: Object.fromEntries(
      [
        'phase0_normalize', 'phase1_fto', 'phase2_physchem',
        'phase3_crossDomainFusion', 'phase4_envelopeAdaptation',
        'phase5_emit', 'phase6_selfVerify',
      ].map((p) => [p, { status: 'PASS', conflicts: [] }]),
    ),
    openQuestions: [],
    ...overrides,
  };
}

test('a clean envelope passes phase 6 — no manufactured conflicts', () => {
  const env = baseEnvelope();
  const { blocking, advisory } = applyHarness(env, [], { today: TODAY });
  assert.deepEqual(blocking, []);
  assert.deepEqual(advisory, []);
  assert.equal(env.verification.phase6_selfVerify.status, 'PASS');
});

test('U1 corridors are confirmed against real retrieval, not demoted blindly', () => {
  const env = baseEnvelope({
    designCorridors: [
      {
        parameter: 'Phenol concentration',
        lowerBound: 0.5, upperBound: 0.6, unit: '% w/w',
        zoneType: 'PERMITTED', rldMatched: true,
        evidenceClass: 'U1',
        sourceRefs: ['US-11318191-B2 Claim 1'],
      },
    ],
  });

  const toolOutputs = [
    {
      tool: 'document_reason',
      status: 'success',
      output: { retrievedFromBigQuery: ['US-11318191-B2'], evidenceClass: 'U1' },
    },
  ];

  const { advisory } = applyHarness(env, [...toolOutputs, comparisonFor(0.5, 0.6)], { today: TODAY });
  assert.equal(env.designCorridors[0].evidenceClass, 'U1', 'confirmed retrieval must keep U1');
  assert.equal(advisory.length, 0);
  assert.equal(env.verification.phase6_selfVerify.status, 'PASS');
});

test('an unconfirmed U1 corridor is demoted, but that alone does not fail phase 6', () => {
  const env = baseEnvelope({
    designCorridors: [
      {
        parameter: 'Phenol concentration',
        lowerBound: 0.5, upperBound: 0.6, unit: '% w/w',
        zoneType: 'PERMITTED', rldMatched: true,
        evidenceClass: 'U1',
        sourceRefs: ['US-11318191-B2 Claim 1'],
      },
    ],
  });

  const { blocking, advisory } = applyHarness(env, [comparisonFor(0.5, 0.6)], { today: TODAY });
  assert.equal(env.designCorridors[0].evidenceClass, 'U2');
  assert.equal(advisory.length, 1);
  assert.deepEqual(blocking, []);
  assert.equal(
    env.verification.phase6_selfVerify.status,
    'PASS',
    'an evidence downgrade is not a verification failure',
  );
});

test('the RLD-matching corridor is NOT flipped to EXCLUDED by the pathway gate', () => {
  // The original rule flipped every PERMITTED excipient corridor on a 505(j)
  // parenteral, inverting the only compliant formulation into "do not use".
  const env = baseEnvelope({
    designCorridors: [
      {
        parameter: 'Phenol concentration',
        lowerBound: 0.5, upperBound: 0.6, unit: '% w/w',
        zoneType: 'PERMITTED', rldMatched: true, evidenceClass: 'U2', sourceRefs: [],
      },
      {
        parameter: 'pH',
        lowerBound: 7.0, upperBound: 7.8, unit: 'pH units',
        zoneType: 'PERMITTED', rldMatched: true, evidenceClass: 'U2', sourceRefs: [],
      },
    ],
  });

  const { blocking } = applyHarness(
    env,
    [comparisonFor(0.5, 0.6), comparisonFor(7.0, 7.8)],
    { today: TODAY },
  );
  assert.equal(env.designCorridors[0].zoneType, 'PERMITTED');
  assert.equal(env.designCorridors[1].zoneType, 'PERMITTED');
  assert.equal(env.designCorridors[0].pathwayCompatible, true);
  assert.deepEqual(blocking, []);
});

test('a corridor deviating from the RLD IS flipped and blocks', () => {
  const env = baseEnvelope({
    designCorridors: [
      {
        parameter: 'Histidine buffer concentration',
        lowerBound: 5, upperBound: 20, unit: 'mM',
        zoneType: 'PERMITTED', rldMatched: false, evidenceClass: 'U2', sourceRefs: [],
      },
    ],
  });

  const { blocking } = applyHarness(env, [comparisonFor(5, 20)], { today: TODAY });
  assert.equal(env.designCorridors[0].zoneType, 'EXCLUDED');
  assert.equal(env.designCorridors[0].pathwayCompatible, false);
  assert.equal(blocking.length, 1);
  assert.equal(env.verification.phase6_selfVerify.status, 'FAIL');
});

test('an unstated rldMatched raises an open question rather than guessing', () => {
  const env = baseEnvelope({
    designCorridors: [
      {
        parameter: 'Propylene glycol concentration',
        lowerBound: 1, upperBound: 2, unit: '% w/w',
        zoneType: 'PERMITTED', evidenceClass: 'U2', sourceRefs: [],
      },
    ],
  });

  const { blocking, advisory } = applyHarness(env, [comparisonFor(1, 2)], { today: TODAY });
  assert.equal(env.designCorridors[0].zoneType, 'PERMITTED', 'must not guess');
  assert.equal(env.designCorridors[0].pathwayCompatible, null);
  assert.equal(advisory.length, 1);
  assert.deepEqual(blocking, []);
  assert.ok(env.openQuestions.some((q) => /rldMatched/.test(q)));
});

test('the pathway gate does not fire for oral dosage forms', () => {
  const env = baseEnvelope({
    targetProduct: { dosageForm: 'Tablet', regulatoryPathway: 'ANDA 505(j)' },
    designCorridors: [
      { parameter: 'Buffer', zoneType: 'PERMITTED', rldMatched: false, evidenceClass: 'U2', sourceRefs: [] },
    ],
  });
  applyHarness(env, [], { today: TODAY });
  assert.equal(env.designCorridors[0].zoneType, 'PERMITTED');
});

test('expired patents are stripped from constraints and corridors, and block', () => {
  const env = baseEnvelope({
    constraintsForDOE: [
      { type: 'EXCLUSION', description: 'Avoid X', evidenceClass: 'U1', sourceRefs: ['US-9999999-B2'] },
      { type: 'REQUIREMENT', description: 'Keep Y', evidenceClass: 'U2', sourceRefs: ['US-1111111-B2'] },
    ],
    designCorridors: [
      { parameter: 'Blocked', zoneType: 'EXCLUDED', evidenceClass: 'U2', sourceRefs: ['US-9999999-B2'] },
    ],
  });

  const toolOutputs = [
    {
      tool: 'orange_book_agent',
      status: 'success',
      output: {
        patents: [
          { patent_number: '9999999', expiration_date: '20260101' }, // expired
          { patent_number: '1111111', expiration_date: '20340101' }, // active
        ],
      },
    },
  ];

  const { blocking } = applyHarness(env, toolOutputs, { today: TODAY });
  assert.equal(env.constraintsForDOE.length, 1);
  assert.equal(env.constraintsForDOE[0].description, 'Keep Y');
  assert.equal(env.designCorridors.length, 0);
  assert.equal(blocking.length, 2);
  assert.equal(env.verification.phase6_selfVerify.status, 'FAIL');
});

test('an S1 corridor is demoted and blocks', () => {
  const env = baseEnvelope({
    designCorridors: [
      {
        parameter: 'Anything',
        lowerBound: 1,
        upperBound: 5,
        zoneType: 'EXCLUDED',
        evidenceClass: 'S1',
        sourceRefs: [],
      },
    ],
  });
  const { blocking } = applyHarness(env, [], { today: TODAY });
  assert.equal(env.designCorridors[0].evidenceClass, 'U2');
  assert.ok(blocking.some((b) => /cannot be S1/.test(b)));
});

test('an unconfirmed U1 constraint is demoted like an unconfirmed U1 corridor', () => {
  const env = baseEnvelope({
    constraintsForDOE: [
      {
        type: 'EXCLUSION',
        description: 'Do not formulate with phenol 0-0.1% w/w.',
        evidenceClass: 'U1',
        sourceRefs: ['US-11318191-B2 Claim 1'],
      },
    ],
  });

  applyHarness(env, [], { today: TODAY });
  assert.equal(env.constraintsForDOE[0].evidenceClass, 'U2');

  const confirmed = baseEnvelope({
    constraintsForDOE: [
      {
        type: 'EXCLUSION',
        description: 'Do not formulate with phenol 0-0.1% w/w.',
        evidenceClass: 'U1',
        sourceRefs: ['US-11318191-B2 Claim 1'],
      },
    ],
  });
  applyHarness(
    confirmed,
    [{ tool: 'document_reason', status: 'success', output: { retrievedFromBigQuery: ['US-11318191-B2'] } }],
    { today: TODAY },
  );
  assert.equal(confirmed.constraintsForDOE[0].evidenceClass, 'U1');
});

test('a recalled regulatory citation tagged S1 is demoted to I', () => {
  const env = baseEnvelope({
    constraintsForDOE: [
      {
        type: 'REQUIREMENT',
        description: 'Sterile manufacturing per USP <788>.',
        evidenceClass: 'S1',
        sourceRefs: ['USP <788> Particulate Matter in Injections'],
      },
    ],
  });
  const { advisory } = applyHarness(env, [], { today: TODAY });
  assert.equal(env.constraintsForDOE[0].evidenceClass, 'I');
  assert.ok(env.constraintsForDOE[0].evidenceClassNote);
  assert.equal(advisory.length, 1);
});

test('an S1 constraint traceable to a real query is kept', () => {
  const env = baseEnvelope({
    constraintsForDOE: [
      {
        type: 'REQUIREMENT',
        description: 'Matches RLD application.',
        evidenceClass: 'S1',
        sourceRefs: ['NDA 209637'],
      },
    ],
  });
  const toolOutputs = [
    {
      tool: 'orange_book_agent',
      status: 'success',
      output: { patents: [], products: [{ application_number: 'NDA209637' }] },
    },
  ];
  applyHarness(env, toolOutputs, { today: TODAY });
  assert.equal(env.constraintsForDOE[0].evidenceClass, 'S1');
});

test('hasParseError fails phase 1 and phase 6', () => {
  const env = baseEnvelope();
  const toolOutputs = [
    { tool: 'patent_fto_agent', status: 'success', output: { hasParseError: true } },
  ];
  const { blocking } = applyHarness(env, toolOutputs, { today: TODAY });
  assert.equal(env.verification.phase1_fto.status, 'FAIL');
  assert.equal(env.verification.phase6_selfVerify.status, 'FAIL');
  assert.ok(blocking.some((b) => /phase1_fto/.test(b)));
});

test('conditional risk strings are normalised to the worst level, keeping the prose', () => {
  const env = baseEnvelope({
    ftoRiskMap: {
      formulation: { risk: 'LOW (for ANDA 505(j)); HIGH (for 505(b)(2) variants)', sourceRefs: [] },
      polymorph: { risk: 'low', sourceRefs: [] },
    },
  });
  applyHarness(env, [], { today: TODAY });
  assert.equal(env.ftoRiskMap.formulation.risk, 'HIGH');
  assert.match(env.ftoRiskMap.formulation.riskQualifier, /505\(b\)\(2\)/);
  assert.equal(env.ftoRiskMap.polymorph.risk, 'LOW');
});

test('a GO status is downgraded when verification fails', () => {
  const env = baseEnvelope({
    executiveSummary: { status: 'GO', rationale: 'All clear.' },
    designCorridors: [
      { parameter: 'X', zoneType: 'EXCLUDED', evidenceClass: 'S1', sourceRefs: [] },
    ],
  });
  applyHarness(env, [], { today: TODAY });
  assert.equal(env.executiveSummary.status, 'REVIEW');
  assert.match(env.executiveSummary.rationale, /HARNESS/);
});

test('a truncated patent search raises an open question', () => {
  const env = baseEnvelope();
  const toolOutputs = [
    {
      tool: 'patent_fto_agent',
      status: 'success',
      output: { coverageAttestation: { patentsFound: 100, searchLimit: 100 } },
    },
  ];
  const { advisory } = applyHarness(env, toolOutputs, { today: TODAY });
  assert.ok(advisory.some((a) => /truncated/.test(a)));
  assert.ok(env.openQuestions.some((q) => /cap/.test(q)));
});

/* ── Rule 14: the operands of a comparison must be grounded ───────────────── */

/** A document_reason output whose extraction carries the real claim limits. */
function naclExtraction() {
  return {
    tool: 'document_reason',
    status: 'success',
    output: {
      retrievedFromBigQuery: ['US-11318191-B2'],
      extracted: {
        sodiumChloride: '2 to 8.9 mg/mL, 5 to 12 mg/mL, 8.1 to 12 mg/mL, 8.2 to 8.9 mg/mL, and 25 mg/mL',
        phenol: '0 to 0.1 mg/mL',
      },
    },
  };
}

/** An in_range call with real params, as the orchestrator actually records it. */
function inRangeCall(params) {
  return {
    tool: 'arithmetic',
    input: { operation: 'in_range', params },
    status: 'success',
    // The real tool echoes its operands back in inputs/normalized/derivation.
    output: {
      result: true,
      normalized: { value: params.value, lower: params.lower, upper: params.upper },
      inputs: { ...params },
      derivation: `in_range(${params.lower} <= ${params.value} <= ${params.upper}) = true`,
      evidenceClass: 'S2',
    },
  };
}

test('rule 14 blocks a comparison whose bound no tool ever returned', () => {
  // The observed failure: the summary claimed "> 6.4 mg/mL NaCl" and in_range
  // tested (6.4, 12]. 6.4 appears nowhere in the retrieved claim text.
  const env = baseEnvelope();
  const { blocking } = applyHarness(
    env,
    [naclExtraction(), inRangeCall({ value: 8.25, lower: 6.4, upper: 12, label: 'NaCl' })],
    { today: TODAY },
  );

  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /lower=6\.4/);
  assert.match(blocking[0], /no tool returned this session/);
  // The comparison being deterministic is exactly why this needed catching.
  assert.match(blocking[0], /overstates the evidence/);
});

test('rule 14 is not fooled by the tool echoing its own operands back', () => {
  // inputs/normalized/derivation all contain 6.4. If those counted as
  // provenance the rule would silently never fire.
  const call = inRangeCall({ value: 8.25, lower: 6.4, upper: 12, label: 'NaCl' });
  assert.ok(JSON.stringify(call.output).includes('6.4'), 'fixture must echo the operand');

  const { blocking } = applyHarness(baseEnvelope(), [naclExtraction(), call], { today: TODAY });
  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /6\.4/);
});

/** The RLD's own composition, which is where the tested value comes from. */
function rldComposition() {
  return {
    tool: 'rld_profile',
    status: 'success',
    output: {
      rld: { brandName: 'Ozempic', applicationNumber: 'NDA209637' },
      compositions: [{ ingredient: 'sodium chloride', concentrationMgPerMl: 8.25 }],
      presentations: [
        { label: '2 mg/3 mL', volumeMl: 3, concentrationMgPerMl: 0.67 },
        { label: '0.25 mg/0.5 mL', volumeMl: 0.5, concentrationMgPerMl: 0.5 },
      ],
    },
  };
}

test('rule 14 accepts operands that appear in the retrieved claim text', () => {
  // The bounds come from the claim extraction and the tested value from the RLD
  // label — both retrieved, so nothing is blocked.
  const { blocking } = applyHarness(
    baseEnvelope(),
    [
      naclExtraction(),
      rldComposition(),
      inRangeCall({ value: 8.25, lower: 8.2, upper: 8.9, label: 'NaCl' }),
    ],
    { today: TODAY },
  );
  assert.deepEqual(blocking, []);
});

test('rule 14 blocks a real bound tested against an unsourced product value', () => {
  // Inverse of the observed bug: the claim range is genuine, but the value
  // being tested against it was never retrieved from the label.
  const { blocking } = applyHarness(
    baseEnvelope(),
    [naclExtraction(), inRangeCall({ value: 8.25, lower: 8.2, upper: 8.9, label: 'NaCl' })],
    { today: TODAY },
  );
  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /value=8\.25/);
});

test('rule 14 ignores 0, 1 and 100 — they carry no provenance signal', () => {
  const { blocking } = applyHarness(
    baseEnvelope(),
    [naclExtraction(), inRangeCall({ value: 0, lower: 0, upper: 0.1, label: 'phenol' })],
    { today: TODAY },
  );
  assert.deepEqual(blocking, []);
});

test('rule 14 treats a previous arithmetic result as grounded', () => {
  const derived = {
    tool: 'arithmetic',
    input: { operation: 'eval', params: { expression: '3 * 2.75' } },
    status: 'success',
    output: { result: 8.25, evidenceClass: 'S2' },
  };
  const { blocking } = applyHarness(
    baseEnvelope(),
    [naclExtraction(), derived, inRangeCall({ value: 8.25, lower: 8.2, upper: 8.9 })],
    { today: TODAY },
  );
  assert.deepEqual(blocking, []);
});

/* ── Rule 15: a term-setting date must say what it is ─────────────────────── */

function orangeBookWithSubmission(submissionDate) {
  return {
    tool: 'orange_book_agent',
    status: 'success',
    output: {
      patents: [
        { patent_number: '9750788', submission_date: submissionDate, expiration_date: 'Mar 18, 2031' },
      ],
    },
  };
}

test('rule 15 blocks an Orange Book submission date used as the term-setting date', () => {
  const env = baseEnvelope();
  env.executiveSummary.patentExpiry = {
    date: '2031-03-18',
    termSettingDate: '2026-02-04',
    basis: 'unknown',
  };

  const { blocking } = applyHarness(env, [orangeBookWithSubmission('2026-02-04')], { today: TODAY });

  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /submission date/);
  assert.match(blocking[0], /not when it was\s+filed/);
  assert.ok(env.executiveSummary.patentExpiry.termSettingDateWarning);
});

test('rule 15 flags a specific term-setting date whose basis is unstated', () => {
  const env = baseEnvelope();
  env.executiveSummary.patentExpiry = {
    date: '2031-03-18',
    termSettingDate: '2006-03-20',
    basis: 'unknown',
  };

  const { blocking, advisory } = applyHarness(env, [orangeBookWithSubmission('2026-02-04')], {
    today: TODAY,
  });

  assert.deepEqual(blocking, []);
  assert.ok(advisory.some((a) => /without saying what kind of\s+date it is/.test(a)));
});

test('rule 14 treats the requested strength as provenance, not invention', () => {
  // Resolving "2 mg/1.5 mL" against the RLD's presentations is the whole point
  // of the strength check; 1.5 came from the caller, not from the model.
  const { blocking } = applyHarness(
    baseEnvelope(),
    [
      rldComposition(),
      {
        tool: 'arithmetic',
        input: { operation: 'compare', params: { a: 1.5, b: 3, unit: 'mL' } },
        status: 'success',
        output: { result: false, inputs: { a: 1.5, b: 3 }, evidenceClass: 'S2' },
      },
    ],
    { today: TODAY, strength: '2 mg/1.5 mL', dosageForm: 'Injection' },
  );
  // Scoped to rule 14: the strength-resolution rule legitimately fires here
  // too, because 1.5 mL matches none of the fixture's presentations.
  assert.equal(
    blocking.filter((b) => /no tool returned this session/.test(b)).length,
    0,
    '1.5 came from the caller, so it must not be reported as invented',
  );
});

test('rule 14 still blocks invention when a request context is present', () => {
  const { blocking } = applyHarness(
    baseEnvelope(),
    [naclExtraction(), inRangeCall({ value: 8.25, lower: 6.4, upper: 12, label: 'NaCl' })],
    { today: TODAY, strength: '2 mg/1.5 mL', dosageForm: 'Injection' },
  );
  assert.ok(blocking.some((b) => /lower=6\.4/.test(b)), 'the fabricated bound must still be caught');
});

/* ── Rule 16: the verdict must answer the pathway that was asked ──────────── */

test('rule 16 discloses and softens a verdict reached on only one requested pathway', () => {
  // The observed case: objective named ANDA/505(b)(2), the envelope analysed
  // 505(j) alone and returned NO_GO on Q1/Q2 sameness grounds.
  const env = baseEnvelope();
  env.targetProduct.regulatoryPathway = 'ANDA 505(j)';
  env.executiveSummary.status = 'NO_GO';
  env.executiveSummary.rationale = 'Q1/Q2 sameness leaves no design freedom.';

  const { advisory } = applyHarness(env, [], {
    today: TODAY,
    objective: 'Generic FTO analysis (ANDA/505(b)(2) pathway)',
  });

  assert.deepEqual(env.pathwayScope.notAnalysed, ['505(b)(2)']);
  assert.equal(env.pathwayScope.originalStatus, 'NO_GO');
  // A definitive verdict on part of the question is not a definitive verdict.
  assert.equal(env.executiveSummary.status, 'REVIEW');
  assert.match(env.executiveSummary.rationale, /^\[PATHWAY\] Analysed as ANDA 505\(j\) only\./);
  assert.match(env.executiveSummary.rationale, /permits\s+formulation changes/);
  assert.ok(env.openQuestions.some((q) => /PATHWAY NOT ANALYSED: 505\(b\)\(2\)/.test(q)));
  assert.ok(advisory.some((a) => /was not covered/.test(a)));
});

test('rule 16 stays silent when the analysed pathway is the one requested', () => {
  const env = baseEnvelope();
  env.targetProduct.regulatoryPathway = 'ANDA 505(j)';
  env.executiveSummary.status = 'NO_GO';

  const { advisory } = applyHarness(env, [], {
    today: TODAY,
    objective: 'Generic FTO analysis, ANDA 505(j) pathway',
  });

  assert.equal(env.pathwayScope, undefined);
  assert.equal(env.executiveSummary.status, 'NO_GO', 'a fully answered question keeps its verdict');
  assert.equal(advisory.filter((a) => /not covered/.test(a)).length, 0);
});

test('rule 16 does not fire when the objective names no pathway', () => {
  const env = baseEnvelope();
  env.targetProduct.regulatoryPathway = 'ANDA 505(j)';
  applyHarness(env, [], { today: TODAY, objective: 'Extended release formulation development' });
  assert.equal(env.pathwayScope, undefined);
});

test('rule 16 keeps its banner ahead of the scope banner', () => {
  const env = baseEnvelope();
  env.targetProduct.regulatoryPathway = 'ANDA 505(j)';
  env.executiveSummary.status = 'NO_GO';
  env.executiveSummary.rationale = 'Blocked.';

  applyHarness(
    env,
    [
      {
        tool: 'patent_fto_agent',
        status: 'success',
        output: { coverageAttestation: { searchScope: 'title only' } },
      },
    ],
    { today: TODAY, objective: 'FTO under ANDA/505(b)(2)' },
  );

  // Both disclosures present, pathway first — it changes what the verdict means.
  assert.match(env.executiveSummary.rationale, /^\[PATHWAY\]/);
  assert.match(env.executiveSummary.rationale, /\[SCOPE\]/);
});

test('a reissue whose claims could not be retrieved is called out by name', () => {
  const env = baseEnvelope();
  const { advisory } = applyHarness(
    env,
    [
      {
        tool: 'document_reason',
        status: 'success',
        output: {
          retrievedFromBigQuery: ['US-11318191-B2'],
          retrievalFailures: [
            { id: 'RE46363', reason: 'HTTP 404 — publication not found' },
            { id: 'US-9999999-B2', reason: 'HTTP 404 — publication not found' },
          ],
        },
      },
    ],
    { today: TODAY },
  );

  const claimText = env.scopeLimitations.find((l) => l.kind === 'CLAIM_TEXT');
  assert.match(claimText.detail, /RE46363 is a reissue/);
  assert.match(claimText.detail, /may broaden the claims/);
  assert.ok(env.openQuestions.some((q) => /REISSUE CLAIM SCOPE UNKNOWN: RE46363/.test(q)));
  assert.ok(advisory.some((a) => /CLAIM_TEXT/.test(a)));
});

test('an ordinary retrieval failure does not get the reissue warning', () => {
  const env = baseEnvelope();
  applyHarness(
    env,
    [
      {
        tool: 'document_reason',
        status: 'success',
        output: {
          retrievedFromBigQuery: [],
          retrievalFailures: [{ id: 'US-9999999-B2', reason: 'HTTP 404' }],
        },
      },
    ],
    { today: TODAY },
  );
  const claimText = env.scopeLimitations.find((l) => l.kind === 'CLAIM_TEXT');
  assert.doesNotMatch(claimText.detail, /reissue/);
  assert.equal(env.openQuestions.filter((q) => /REISSUE/.test(q)).length, 0);
});
