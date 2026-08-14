import { normalizePatentDate, toCompact } from '../dates.js';
import { matchPresentation, parseStrength, concentrationsMatch } from '../strength.js';
import {
  selectDeliverable,
  buildSpecification,
  isDegenerate,
  DELIVERABLE,
} from './specification.js';

/**
 * Deterministic post-processing of the emitted envelope.
 *
 * These are the rules the model cannot be trusted to self-police, applied in
 * code against the actual tool outputs. Two design points matter:
 *
 *  1. Provenance comes from `toolOutputs`, the real recorded agent responses.
 *     (An earlier version read a `outputRaw` field that was never populated,
 *     so every rule that depended on it silently did nothing — while the U1
 *     verification, seeing an empty retrieved-ID set, demoted *every* corridor
 *     and forced phase 6 to FAIL on every run.)
 *
 *  2. Findings are split into `blocking` and `advisory`. Only blocking
 *     findings fail phase 6. A demotion that merely records normal uncertainty
 *     is not a verification failure.
 *
 * The harness plays TWO distinct roles, and conflating them hid a whole class
 * of error for a long time:
 *
 *   PROVENANCE AUDITOR (rules 1-10) — "was this retrieved, and is it cited
 *     honestly?" Catches evidence-class inflation, expired citations, search
 *     truncation, phase cascades. This part has always worked.
 *
 *   LOGIC AUDITOR (rules 11+) — "does the stated conclusion follow from the
 *     numbers retrieved?" Range containment, concentration matching and claim
 *     coverage are verdict-driving comparisons, and for 16 recorded runs
 *     nothing checked them: they were asserted in prose inside the same
 *     generation pass doing the legal reasoning. A citation auditor cannot
 *     catch a arithmetic error, however rigorous it is about sources.
 */

const RISK_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

const PHASES = [
  'phase0_normalize',
  'phase1_fto',
  'phase2_physchem',
  'phase3_crossDomainFusion',
  'phase4_envelopeAdaptation',
  'phase5_emit',
];

// Excipient/parameter names that a Q1/Q2 sameness check applies to. Anchored
// with word boundaries: an unanchored /ph/ also matches "PHenol", "phosphate"
// and "morphology", which previously double-fired this rule.
const EXCIPIENT_PARAM =
  /\b(excipient|buffer|preservative|pH|phenol|cresol|phosphate|histidine|NaCl|sodium chloride|mannitol|polysorbate|propylene glycol|benzyl alcohol)\b/i;

const PARENTERAL =
  /\b(injection|injectable|infusion|implant|subcutaneous|intravenous|intramuscular|parenteral)\b/i;

const ANDA_505J = /505\(j\)|\bANDA\b/i;

/**
 * @param {object} envelope   developmentConstraintEnvelope (mutated in place)
 * @param {Array}  toolOutputs [{ tool, status, output }]
 * @param {object} ctx        { today: 'YYYY-MM-DD', dosageForm }
 * @returns {{ blocking: string[], advisory: string[] }}
 */
export function applyHarness(envelope, toolOutputs = [], ctx = {}) {
  const blocking = [];
  const advisory = [];
  const today = ctx.today || new Date().toISOString().slice(0, 10);

  const outputs = (tool) =>
    toolOutputs.filter((t) => t.tool === tool && t.status === 'success' && t.output);

  // ── Rule 1: expired patents may not appear in constraints or corridors ──
  const expired = expiredPatentNumbers(outputs('orange_book_agent'), today);
  if (expired.size > 0) {
    const removedConstraints = removeWhereCitesAny(
      envelope,
      'constraintsForDOE',
      expired,
      (c) => (c.sourceRefs || []).join(' ') + ' ' + (c.description || ''),
    );
    if (removedConstraints.length > 0) {
      blocking.push(
        `Removed ${removedConstraints.length} constraintsForDOE entr${removedConstraints.length === 1 ? 'y' : 'ies'} citing patents expired before ${today}: ${removedConstraints.join(', ')}.`,
      );
    }

    const removedCorridors = removeWhereCitesAny(
      envelope,
      'designCorridors',
      expired,
      (c) => (c.sourceRefs || []).join(' ') + ' ' + (c.bindingConstraint || ''),
    );
    if (removedCorridors.length > 0) {
      blocking.push(
        `Removed ${removedCorridors.length} designCorridor(s) bound by expired patents: ${removedCorridors.join(', ')}.`,
      );
    }
  }

  if (expired.size > 0) annotateExpiredRisks(envelope, expired, today, advisory);

  // ── Rule 2: a design corridor is never S1 ──
  // Corridors are interpretations of claim scope, not query results.
  for (const c of envelope.designCorridors || []) {
    if (c.evidenceClass === 'S1') {
      c.evidenceClass = 'U2';
      blocking.push(
        `designCorridor '${c.parameter}' carried evidenceClass S1; corridors are interpretive and cannot be S1. Demoted to U2.`,
      );
    }
  }

  // ── Rule 3: U1 requires confirmed primary-document retrieval ──
  // Applies to anything claiming U1, not just corridors: a DOE constraint
  // asserting a claim limit is making the same provenance claim.
  // Primary text is a retrieved patent claim OR the RLD label, so a
  // label-sourced value must not be demoted merely for lacking a patent id.
  const retrievedIds = retrievedFromBigQuery(outputs('document_reason'));
  const labelRefs = rldLabelRefs(toolOutputs);
  const demoteUnconfirmedU1 = (entry, label) => {
    if (entry.evidenceClass !== 'U1') return;
    const refs = entry.sourceRefs || [];
    if (refs.some((r) => citesRetrievedPatent(r, retrievedIds))) return;
    if (refs.some((r) => citesRetrievedLabel(r, labelRefs))) return;
    entry.evidenceClass = 'U2';
    // Advisory, not blocking: the value is still usable, its provenance is
    // simply weaker than claimed, and the corrected class now says so.
    advisory.push(
      `${label} demoted U1 to U2 — no cited source was confirmed retrieved this session ` +
        '(neither a patent claim nor the RLD label).',
    );
  };

  for (const c of envelope.designCorridors || []) {
    demoteUnconfirmedU1(c, `designCorridor '${c.parameter}'`);
  }
  for (const [i, c] of (envelope.constraintsForDOE || []).entries()) {
    demoteUnconfirmedU1(c, `constraintsForDOE[${i}] (${c.type})`);
  }

  // ── Rule 4: S1 requires an actual structured query ──
  // A recalled CFR/USP/ICH citation is inference, not a query result.
  const queriedRefs = queriedSourceRefs(toolOutputs);
  for (const c of envelope.constraintsForDOE || []) {
    if (c.evidenceClass !== 'S1') continue;
    const refs = c.sourceRefs || [];
    if (!refs.some((r) => queriedRefs.some((q) => refMatches(r, q)))) {
      c.evidenceClass = 'I';
      c.evidenceClassNote =
        'Demoted from S1: no structured query in this session returned this source. Treat as inferred and verify against the primary regulation or standard.';
      advisory.push(
        `constraintsForDOE entry (${refs.join(', ') || 'no refs'}) demoted S1 to I — not traceable to a structured query this session.`,
      );
    }
  }

  // ── Rule 5: pathway consistency for parenteral ANDAs ──
  applyPathwayGate(envelope, ctx, blocking, advisory);

  // ── Rule 6: propagate FTO parse failures ──
  const ftoOutput = outputs('patent_fto_agent')[0]?.output;
  if (ftoOutput?.hasParseError === true) {
    ensurePhase(envelope, 'phase1_fto');
    envelope.verification.phase1_fto.status = 'FAIL';
    envelope.verification.phase1_fto.conflicts = [
      ...(envelope.verification.phase1_fto.conflicts || []),
      'patent_fto_agent reported hasParseError=true. Classification is incomplete.',
    ];
    blocking.push(
      'phase1_fto forced to FAIL: the FTO agent could not classify one or more batches.',
    );
  }

  // ── Rule 7: surface search truncation ──
  const coverage = ftoOutput?.coverageAttestation;
  if (coverage && coverage.patentsFound >= (coverage.searchLimit ?? Infinity)) {
    advisory.push(
      `Patent search returned the maximum of ${coverage.searchLimit} results — the landscape is truncated and additional patents likely exist.`,
    );
    envelope.openQuestions = [
      ...(envelope.openQuestions || []),
      `Patent search hit the ${coverage.searchLimit}-result cap. Re-run with a narrower query or pagination before treating this landscape as complete.`,
    ];
  }

  // ── Rule 8: normalise risk labels so downstream consumers can switch on them ──
  normaliseRisks(envelope, advisory);

  // ── Rule 11 (logic): a numeric verdict needs a deterministic comparison ──
  requireNumericBacking(envelope, toolOutputs, blocking, advisory);

  // ── Rule 14 (grounding): the operands of that comparison must be real ──
  requireGroundedComparisonInputs(toolOutputs, blocking, ctx);

  // ── Rule 15: a term-setting date must say what date it actually is ──
  checkTermSettingDate(envelope, toolOutputs, blocking, advisory);

  // ── Rule 12 (scope): cost/infra limits must be visible in the verdict ──
  surfaceScopeLimitations(envelope, toolOutputs, ctx, advisory);

  // ── Rule 16: the verdict must answer the pathway that was asked about ──
  // After rule 12 deliberately: this banner belongs at the very front of the
  // rationale, ahead of the scope banner.
  checkPathwayScope(envelope, ctx, advisory);

  // ── Rule 8b: deliverable selection and strength resolution ──
  applyDeliverableMode(envelope, toolOutputs, ctx, blocking, advisory);

  // ── Rule 8c: a failed phase invalidates the phases that consume it ──
  propagateFailures(envelope, advisory);

  // ── Rule 9: phase 6 truth gate ──
  const upstreamFailed = PHASES.some(
    (p) => envelope.verification?.[p]?.status === 'FAIL',
  );
  ensurePhase(envelope, 'phase6_selfVerify');

  const phase6 = envelope.verification.phase6_selfVerify;
  const failing = upstreamFailed || blocking.length > 0;
  phase6.status = failing ? 'FAIL' : 'PASS';
  phase6.conflicts = [
    ...(phase6.conflicts || []),
    ...blocking.map((c) => `HARNESS (blocking): ${c}`),
    ...advisory.map((c) => `HARNESS (advisory): ${c}`),
    ...(upstreamFailed ? ['One or more upstream phases failed.'] : []),
  ];

  // ── Rule 13 (reproducibility): mandatory caveats are derived, not authored ──
  addMandatoryCaveats(envelope, toolOutputs);

  // ── Rule 10: headline status must not contradict verification ──
  if (failing && envelope.executiveSummary) {
    const status = envelope.executiveSummary.status;
    if (status === 'GO') {
      envelope.executiveSummary.status = 'REVIEW';
      envelope.executiveSummary.rationale =
        `[HARNESS] Downgraded from GO to REVIEW: verification failed. ` +
        (envelope.executiveSummary.rationale || '');
    }
  }

  return { blocking, advisory };
}

/* ───────────────────────── helpers ───────────────────────── */

function ensurePhase(envelope, key) {
  envelope.verification = envelope.verification || {};
  envelope.verification[key] = envelope.verification[key] || {
    status: 'PASS',
    conflicts: [],
  };
}

function expiredPatentNumbers(orangeBookOutputs, today) {
  const todayCompact = toCompact(today);
  const expired = new Set();
  for (const { output } of orangeBookOutputs) {
    for (const p of output.patents || []) {
      const iso = p.expiration_date_iso || normalizePatentDate(p.expiration_date);
      if (!iso) continue;
      if (iso.replace(/-/g, '') < todayCompact) expired.add(String(p.patent_number));
    }
  }
  return expired;
}

/** Removes entries citing any expired patent; returns the removed entries' labels. */
function removeWhereCitesAny(envelope, key, numbers, textOf) {
  const list = envelope[key];
  if (!Array.isArray(list)) return [];
  const removed = [];
  envelope[key] = list.filter((entry) => {
    const haystack = normaliseRef(textOf(entry));
    const hit = [...numbers].find((n) => haystack.includes(normaliseRef(n)));
    if (hit) {
      removed.push(entry.parameter || entry.type || hit);
      return false;
    }
    return true;
  });
  return removed;
}

/** Patent IDs whose claim text document_reason actually pulled from BigQuery. */
function retrievedFromBigQuery(documentReasonOutputs) {
  const ids = new Set();
  for (const { output } of documentReasonOutputs) {
    for (const id of output.retrievedFromBigQuery || []) {
      ids.add(normaliseRef(id));
    }
  }
  return ids;
}

/**
 * Does a sourceRef such as "US-11318191-B2 Claim 1" cite one of the retrieved
 * publication numbers? Compared with punctuation and kind-codes stripped, so
 * "US-11318191-B2", "US11318191B2" and "11318191" all match.
 */
function citesRetrievedPatent(ref, retrievedIds) {
  const normalised = normaliseRef(ref);
  for (const id of retrievedIds) {
    if (normalised.includes(id)) return true;
    const digits = id.replace(/\D/g, '');
    if (digits.length >= 6 && normalised.includes(digits)) return true;
  }
  return false;
}

function normaliseRef(value) {
  return String(value || '').toUpperCase().replace(/[\s\-_/.]/g, '');
}

function refMatches(a, b) {
  const na = normaliseRef(a);
  const nb = normaliseRef(b);
  return na.includes(nb) || nb.includes(na);
}

/** Identifiers that a successful structured query actually returned. */
function queriedSourceRefs(toolOutputs) {
  const refs = [];
  for (const t of toolOutputs) {
    if (t.status !== 'success' || !t.output) continue;
    if (t.tool === 'orange_book_agent') {
      for (const p of t.output.patents || []) refs.push(String(p.patent_number));
      for (const pr of t.output.products || []) {
        if (pr.application_number) refs.push(String(pr.application_number));
      }
    }
    if (t.tool === 'physchem_agent' && t.output.molecule?.chemblId) {
      refs.push(`ChEMBL:${t.output.molecule.chemblId}`);
    }
    if (t.tool === 'patent_fto_agent') {
      for (const layer of Object.values(t.output.layers || {})) {
        for (const p of layer || []) refs.push(String(p.patentId));
      }
    }
    if (t.tool === 'structured_query' && Array.isArray(t.output.rows)) {
      refs.push('structured_query');
    }
  }
  return refs;
}

/**
 * Q1/Q2 sameness gate, 21 CFR 314.94(a)(9)(iii).
 *
 * A 505(j) parenteral must match the RLD's inactive ingredients and their
 * concentrations. So the rule is about *deviation from the RLD*, not about the
 * parameter being an excipient — the corridor that reproduces the RLD is the
 * one the applicant must hit.
 *
 * Corridors therefore declare `rldMatched`:
 *   true   reproduces the RLD  -> compliant, left PERMITTED
 *   false  deviates from RLD   -> excluded under 505(j), flipped
 *   absent sameness unverified -> left alone, flagged as an open question
 *
 * The previous version flipped every PERMITTED excipient corridor, which
 * inverted the RLD-matching phenol and pH corridors into EXCLUDED and told the
 * DOE generator not to use the only compliant formulation.
 */
function applyPathwayGate(envelope, ctx, blocking, advisory) {
  const pathway = envelope.targetProduct?.regulatoryPathway || '';
  const dosageForm = envelope.targetProduct?.dosageForm || ctx.dosageForm || '';
  if (!ANDA_505J.test(pathway) || !PARENTERAL.test(dosageForm)) return;

  const unverified = [];

  for (const c of envelope.designCorridors || []) {
    const param = c.parameter || '';
    if (!EXCIPIENT_PARAM.test(param)) continue;
    if (c.zoneType !== 'PERMITTED') continue;

    if (c.rldMatched === false) {
      c.zoneType = 'EXCLUDED';
      c.pathwayCompatible = false;
      c.pathwayConflict =
        'ANDA-505j-Q1Q2: deviates from the RLD formulation, which 21 CFR 314.94(a)(9)(iii) does not permit for a parenteral ANDA. Reclassify as a 505(b)(2) strategy.';
      blocking.push(
        `designCorridor '${param}' converted PERMITTED to EXCLUDED: proposes a deviation from the RLD, incompatible with 505(j) Q1/Q2 sameness for a parenteral.`,
      );
    } else if (c.rldMatched === true) {
      // Reproduces the RLD — compliant. Make the reasoning explicit rather
      // than leaving pathwayCompatible unset.
      c.pathwayCompatible = true;
      c.pathwayNote =
        'Reproduces the RLD composition; satisfies Q1/Q2 sameness for a 505(j) parenteral.';
    } else {
      unverified.push(param);
      c.pathwayCompatible = null;
      c.pathwayNote =
        'Q1/Q2 sameness not verified: the corridor does not state whether it reproduces the RLD. Confirm against the RLD composition before use.';
    }
  }

  if (unverified.length > 0) {
    advisory.push(
      `Q1/Q2 sameness unverified for ${unverified.length} excipient corridor(s) (${unverified.join(', ')}) — rldMatched not stated.`,
    );
    envelope.openQuestions = [
      ...(envelope.openQuestions || []),
      `Confirm the RLD's composition and concentrations for: ${unverified.join(', ')}. Each corridor must declare rldMatched true or false before a 505(j) filing decision.`,
    ];
  }
}

/**
 * A phase whose inputs failed cannot itself have passed.
 *
 * Previously only phase 6 consumed upstream failures, so an envelope could
 * report phase 1 FAIL alongside phase 3 "cross-domain fusion: PASS" — fusion
 * passing with nothing to fuse.
 */
const PHASE_DEPENDENCIES = {
  phase3_crossDomainFusion: ['phase0_normalize', 'phase1_fto', 'phase2_physchem'],
  phase4_envelopeAdaptation: ['phase3_crossDomainFusion'],
  phase5_emit: ['phase4_envelopeAdaptation'],
};

export function propagateFailures(envelope, advisory = []) {
  const verification = envelope.verification;
  if (!verification) return;

  // Ordered, so a phase-1 failure reaches phase 5 through phases 3 and 4 in a
  // single pass.
  for (const [phase, dependencies] of Object.entries(PHASE_DEPENDENCIES)) {
    const entry = verification[phase];
    if (!entry || entry.status === 'FAIL') continue;

    const failed = dependencies.filter((d) => verification[d]?.status === 'FAIL');
    if (failed.length === 0) continue;

    entry.status = 'FAIL';
    entry.conflicts = [
      ...(entry.conflicts || []),
      `HARNESS: forced to FAIL — depends on ${failed.join(', ')}, which failed. ` +
        'This phase cannot pass on inputs that were not produced.',
    ];
    advisory.push(
      `verification.${phase} forced to FAIL: its inputs (${failed.join(', ')}) failed.`,
    );
  }
}

/**
 * Select the deliverable shape for this product class, resolve the requested
 * strength against the RLD's real presentations, and replace degenerate
 * corridors with a specification where design freedom is zero.
 */
function applyDeliverableMode(envelope, toolOutputs, ctx, blocking, advisory) {
  const target = envelope.targetProduct || {};
  const deliverable = selectDeliverable({
    regulatoryPathway: target.regulatoryPathway || '',
    dosageForm: target.dosageForm || ctx.dosageForm || '',
  });
  envelope.deliverable = deliverable;

  // The most informative rld_profile result, not the first.
  //
  // The orchestrator legitimately calls this more than once — a brand-name
  // lookup can land on the wrong route and be retried with an application
  // number. Taking the first success made the harness reason about the
  // discarded attempt: it reported "no presentations could be parsed" and
  // skipped strength resolution, while a later call had every presentation in
  // hand.
  const rld =
    toolOutputs
      .filter((t) => t.tool === 'rld_profile' && t.status === 'success' && t.output)
      .map((t) => t.output)
      .sort(
        (a, b) =>
          (b.presentations?.length || 0) - (a.presentations?.length || 0) ||
          (b.compositions?.length || 0) - (a.compositions?.length || 0),
      )[0] || null;

  // ── Strength resolution ──
  const requested = ctx.strength || target.strength;
  if (requested && rld?.presentations?.length) {
    const resolution = matchPresentation(requested, rld.presentations);
    envelope.strengthResolution = {
      requested,
      status: resolution.status,
      resolvedPresentation: resolution.match || null,
      availablePresentations: resolution.candidates.map((p) => ({
        label: p.label,
        concentrationMgPerMl: p.concentrationMgPerMl,
        context: p.context,
      })),
    };

    if (resolution.status === 'NO_MATCH') {
      blocking.push(
        `Requested strength ${requested} does not correspond to any RLD presentation ` +
          `(available: ${resolution.candidates.map((c) => c.label).join('; ')}). The analysis must not ` +
          'silently substitute a different presentation — they have different compositions.',
      );
    } else if (resolution.status === 'MATCH' && resolution.match) {
      // Guard the silent-substitution failure: the envelope's stated strength
      // must be the one that was asked for.
      const stated = String(target.strength || '');
      const resolvedConc = resolution.match.concentrationMgPerMl;
      const statedParsed = parseStrength(stated);
      if (
        statedParsed.mgPerMl != null &&
        !concentrationsMatch(statedParsed.mgPerMl, resolution.requested.mgPerMl)
      ) {
        blocking.push(
          `targetProduct.strength (${stated}) is not the requested strength (${requested}). ` +
            `The request resolves to ${resolution.match.label} (${resolvedConc} mg/mL, ` +
            `${resolution.match.context || 'presentation unstated'}); substituting a different ` +
            'presentation changes the Q1/Q2 target.',
        );
      }
      envelope.targetProduct.resolvedPresentation = resolution.match.label;
      envelope.targetProduct.presentationContext = resolution.match.context || null;
    }
  } else if (requested && rld && !rld.presentations?.length) {
    advisory.push(
      'RLD label retrieved but no presentations could be parsed; the requested strength could not be verified against a real presentation.',
    );
  }

  if (deliverable.type !== DELIVERABLE.RLD_MATCHED_SPECIFICATION) return;

  // ── Specification mode ──
  const corridors = envelope.designCorridors || [];
  const degenerate = corridors.filter(isDegenerate);

  const spec = buildSpecification({
    rld,
    presentation: envelope.strengthResolution?.resolvedPresentation,
    corridors,
  });

  if (spec) {
    envelope.rldSpecification = spec;
    // Degenerate corridors carry no design information and misrepresent the
    // output as an experiment. The specification supersedes them.
    envelope.designCorridors = corridors.filter((c) => !isDegenerate(c));
    if (degenerate.length > 0) {
      advisory.push(
        `${degenerate.length} corridor(s) had zero width (${degenerate.map((c) => c.parameter).join(', ')}) ` +
          'and were replaced by rldSpecification: on a 505(j) parenteral the composition is fixed by ' +
          'Q1/Q2 sameness, so there is no design space to express as a range.',
      );
    }
  } else if (degenerate.length > 0) {
    blocking.push(
      `${degenerate.length} corridor(s) have no bounds and no RLD composition was retrieved ` +
        `(${degenerate.map((c) => c.parameter).join(', ')}). The specification is UNKNOWN — it must be ` +
        'retrieved from the RLD label, not inferred.',
    );
    envelope.openQuestions = [
      ...(envelope.openQuestions || []),
      'Retrieve the RLD composition (FDA label Description section) before any Q1/Q2 claim can be made.',
    ];
  }

  // Only point at the specification when one was actually built — otherwise
  // this is a dangling reference to a null field.
  if (envelope.rldSpecification) {
    envelope.openQuestions = [
      ...(envelope.openQuestions || []),
      'Scope note: on this pathway the DOE effort belongs in process design, not formulation — ' +
        'see rldSpecification.developmentProgram.openToDesign.',
    ];
  }
}

const COMPARISON_OPS = new Set(['in_range', 'compare', 'overlap']);
const BOUND_TOLERANCE = 0.02; // 2%, to absorb label rounding

/** Every deterministic comparison actually performed this session. */
function recordedComparisons(toolOutputs) {
  return toolOutputs
    .filter((t) => t.tool === 'arithmetic' && t.status === 'success' && t.output)
    .filter((t) => COMPARISON_OPS.has(t.input?.operation))
    .map((t) => ({ operation: t.input.operation, output: t.output, input: t.input }));
}

/** Does any recorded comparison actually operate on this number? */
function comparisonCovers(comparisons, target) {
  if (typeof target !== 'number' || !Number.isFinite(target)) return true;
  const close = (x) =>
    typeof x === 'number' &&
    Number.isFinite(x) &&
    (x === target || Math.abs(x - target) <= Math.abs(target || 1) * BOUND_TOLERANCE);

  return comparisons.some((c) => {
    const n = c.output.normalized || {};
    const i = c.output.inputs || {};
    return [
      n.value, n.lower, n.upper, n.a, n.b, n.aLower, n.aUpper, n.bLower, n.bUpper,
      i.value, i.lower, i.upper, i.a, i.b, i.aLower, i.aUpper, i.bLower, i.bUpper,
    ].some(close);
  });
}

/**
 * A corridor that states numeric bounds AND a zone verdict is asserting a
 * containment result. That assertion must be traceable to a comparison the
 * arithmetic tool actually performed — otherwise it was decided in prose.
 */
function requireNumericBacking(envelope, toolOutputs, blocking, advisory) {
  const comparisons = recordedComparisons(toolOutputs);

  for (const c of envelope.designCorridors || []) {
    const bounds = [c.lowerBound, c.upperBound].filter(
      (v) => typeof v === 'number' && Number.isFinite(v),
    );
    if (bounds.length === 0) continue;

    const backed = bounds.every((b) => comparisonCovers(comparisons, b));
    if (backed) {
      c.numericBacking = 'verified';
      continue;
    }
    c.numericBacking = 'unverified';
    blocking.push(
      `designCorridor '${c.parameter}' states bounds [${c.lowerBound ?? '-'}, ${c.upperBound ?? '-'}] ` +
        `${c.unit || ''}`.trim() +
        ' and a ' +
        `${c.zoneType || 'zone'} verdict, but no in_range/compare/overlap call in this session used those ` +
        'numbers. A containment verdict reached in prose is not verified — call the arithmetic tool.',
    );
  }

  // A claim-inversion conclusion is the same shape of assertion: "the RLD
  // concentration lies outside the claimed range, so the patent does not read
  // on it." That is precisely a range check.
  const inversion = envelope.claimInversion || envelope.claimInversionCheck;
  if (inversion && comparisons.length === 0) {
    blocking.push(
      'A claim-inversion conclusion was stated with no in_range/compare/overlap call in this ' +
        'session. Whether a product concentration falls inside a claimed range is a numeric ' +
        'comparison and must be computed, not asserted.',
    );
  }
}

/**
 * Regulatory pathways an objective or a verdict can name.
 *
 * 505(j) is matched by "ANDA" too, since that is how the pathway is usually
 * written; 505(b)(2) needs its own pattern because "ANDA/505(b)(2)" names both
 * and the whole point of this rule is to notice the second one.
 */
const PATHWAYS = [
  { id: '505(b)(2)', pattern: /505\s*\(?\s*b\s*\)?\s*\(?\s*2\s*\)?/i },
  { id: 'ANDA 505(j)', pattern: /505\s*\(?\s*j\s*\)?|\bANDA\b/i },
];

function pathwaysNamedIn(text) {
  const haystack = String(text || '');
  return PATHWAYS.filter((p) => p.pattern.test(haystack)).map((p) => p.id);
}

/**
 * Rule 16 — the answer must be about the question that was asked.
 *
 * Observed: a request whose objective read "Generic FTO analysis (ANDA/505(b)(2)
 * pathway)" was analysed end to end as 505(j) alone — `regulatoryPathway:
 * "ANDA 505(j)"`, `designFreedom: "none"`, and a NO_GO reasoned entirely from
 * Q1/Q2 sameness. That reasoning is correct for 505(j), and 505(j) genuinely
 * forbids the formulation deviation that would design around the excipient
 * claims. But 505(b)(2) exists precisely to permit that deviation with bridging
 * data, so the NO_GO was contingent on a pathway the caller had not restricted
 * it to. The substitution appeared only in a closing open question; the summary
 * and the status field never mentioned it.
 *
 * A reader who stops at the headline concludes the molecule is dead, when the
 * honest answer is "dead under 505(j), open under 505(b)(2)". So the divergence
 * is disclosed where the verdict is read, and a hard GO/NO_GO is softened to
 * REVIEW — a definitive verdict on part of the question is not a definitive
 * verdict on the question.
 */
function checkPathwayScope(envelope, ctx, advisory) {
  const requested = pathwaysNamedIn(ctx.objective);
  if (requested.length === 0) return;

  const analysed = pathwaysNamedIn(envelope.targetProduct?.regulatoryPathway);
  const missing = requested.filter((p) => !analysed.includes(p));
  if (missing.length === 0) return;

  envelope.pathwayScope = {
    requestedInObjective: requested,
    analysed: envelope.targetProduct?.regulatoryPathway || 'unstated',
    notAnalysed: missing,
    note:
      'The objective named more than one regulatory pathway. Every conclusion in this envelope ' +
      `follows from ${envelope.targetProduct?.regulatoryPathway || 'the analysed pathway'} only. ` +
      `${missing.join(' and ')} was not analysed, and the pathways differ on exactly the question ` +
      'that drives this verdict: 505(j) requires Q1/Q2 sameness with the RLD, while 505(b)(2) ' +
      'permits a formulation that differs from it, supported by bridging data.',
  };

  const summary = envelope.executiveSummary;
  if (summary) {
    const banner =
      `[PATHWAY] Analysed as ${envelope.targetProduct?.regulatoryPathway || 'a single pathway'} only. ` +
      `The objective also named ${missing.join(' and ')}, which was NOT analysed and which permits ` +
      'formulation changes this verdict treats as forbidden. This conclusion does not extend to it. ';
    if (!String(summary.rationale || '').startsWith('[PATHWAY]')) {
      summary.rationale = banner + (summary.rationale || '');
    }

    if (summary.status === 'GO' || summary.status === 'NO_GO') {
      envelope.pathwayScope.originalStatus = summary.status;
      summary.status = 'REVIEW';
      envelope.pathwayScope.statusNote =
        `Status downgraded from ${envelope.pathwayScope.originalStatus} to REVIEW: a definitive ` +
        'verdict was reached on one of the pathways asked about, which is not a definitive verdict ' +
        'on the request.';
    }
  }

  envelope.openQuestions = [
    ...(envelope.openQuestions || []),
    `PATHWAY NOT ANALYSED: ${missing.join(', ')}. Re-run with that pathway as the objective before ` +
      'treating this verdict as covering it.',
  ];

  advisory.push(
    `Objective named ${requested.join(', ')} but the envelope analysed ` +
      `${envelope.targetProduct?.regulatoryPathway || 'an unstated pathway'}; ${missing.join(', ')} ` +
      'was not covered. Disclosed in executiveSummary and pathwayScope.',
  );
}

/**
 * Numbers that some tool actually returned this session.
 *
 * Collected by walking every successful tool output: numeric leaves are taken
 * directly, and strings are mined for numeric tokens, because the retrieved
 * claim text carries its limits as prose ("2 to 8.9 mg/mL, 5 to 12 mg/mL").
 */
function groundedNumbers(toolOutputs) {
  const numbers = new Set();
  const texts = [];

  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'number' && Number.isFinite(node)) {
      numbers.add(node);
      return;
    }
    if (typeof node === 'string') {
      if (node.length <= 20000) texts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (typeof node === 'object') {
      for (const v of Object.values(node)) walk(v);
    }
  };

  for (const t of toolOutputs) {
    if (t.status !== 'success' || !t.output) continue;

    if (t.tool === 'arithmetic') {
      // The arithmetic tool echoes its own operands back in `inputs`,
      // `normalized` and the `derivation` string. Walking those would let a
      // fabricated bound ground ITSELF and quietly disable this whole rule.
      // Only genuinely derived outputs count, so that a chained computation
      // (an expiry date feeding a later comparison) still passes.
      walk(t.output.result);
      walk(t.output.value);
      walk(t.output.expiryDate);
      continue;
    }

    walk(t.output);
  }

  return { numbers, text: texts.join('\n') };
}

/** True when `token` appears in `text` bounded by non-digit characters. */
function hasNumberToken(text, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(text);
}

// Ubiquitous values carry no provenance signal — 0 means "absent", 1 and 100
// are percentage and ratio scaffolding. Demanding a citation for these would
// bury the real findings in noise.
const TRIVIAL_OPERANDS = new Set([0, 1, 100]);

const COMPARISON_OPERAND_KEYS = [
  'value', 'lower', 'upper',
  'a', 'b',
  'aLower', 'aUpper', 'bLower', 'bUpper',
];

/**
 * Rule 14 — every operand of a verdict-driving comparison must be traceable to
 * a retrieved value.
 *
 * Rule 11 established that a numeric verdict must come from the arithmetic tool
 * rather than from prose. That closed one hole and opened a worse one: the
 * comparison is now provably correct, stamped S2, and reads as verified — while
 * nothing checks that the numbers going INTO it were ever retrieved.
 *
 * Observed: an executive summary asserted formulation patents covering
 * "> 6.4 mg/mL NaCl" and an in_range call tested exactly the bound (6.4, 12].
 * The NaCl ranges actually extracted from the claim text were 2-8.9, 5-12,
 * 8.1-12, 8.2-8.9 and 25 mg/mL. The number 6.4 appears nowhere in the
 * extraction, nor anywhere else in the trace. The verdict happened to survive
 * — 8.25 sits inside several of the real ranges — but that is luck, not the
 * system catching itself.
 *
 * Verifying the comparison is worthless if its inputs can be invented, so the
 * operands are checked here against what the tools returned.
 */
function requireGroundedComparisonInputs(toolOutputs, blocking, ctx = {}) {
  const comparisons = toolOutputs.filter(
    (t) =>
      t.tool === 'arithmetic' &&
      t.status === 'success' &&
      COMPARISON_OPS.has(t.input?.operation),
  );
  if (comparisons.length === 0) return;

  const { numbers, text } = groundedNumbers(toolOutputs);

  // The request itself is provenance. Resolving "2 mg/1.5 mL" against the RLD's
  // presentations is a comparison the run exists to make, and its 1.5 came from
  // the caller, not from the model — flagging it would fail every run that does
  // the strength check correctly.
  const requested = [ctx.strength, ctx.dosageForm, ctx.molecule]
    .filter((v) => typeof v === 'string' && v)
    .join(' ');

  for (const call of comparisons) {
    const params = call.input?.params || {};
    const ungrounded = [];

    for (const key of COMPARISON_OPERAND_KEYS) {
      const operand = params[key];
      if (typeof operand !== 'number' || !Number.isFinite(operand)) continue;
      if (TRIVIAL_OPERANDS.has(operand)) continue;
      if (numbers.has(operand)) continue;
      if (hasNumberToken(text, operand)) continue;
      if (requested && hasNumberToken(requested, operand)) continue;
      ungrounded.push(`${key}=${operand}`);
    }

    if (ungrounded.length === 0) continue;

    const label = params.label || call.input.operation;
    blocking.push(
      `arithmetic ${call.input.operation} '${label}' was computed over ${ungrounded.length} ` +
        `operand(s) that no tool returned this session: ${ungrounded.join(', ')}. ` +
        'The comparison is deterministic but its inputs are not sourced, so its S2 result ' +
        'overstates the evidence. Every operand must either be copied verbatim from a tool output ' +
        '(a document_reason claim limit, an rld_profile concentration) or be produced by an earlier ' +
        'arithmetic call. A value derived by hand — a strength divided into a concentration, a unit ' +
        'converted mentally — must be computed with arithmetic eval/unit_convert first and that ' +
        'result passed in. Re-run the comparison on sourced operands, or drop the conclusion ' +
        'resting on it.',
    );
  }
}

/**
 * Rule 15 — a term-setting date must be the date it claims to be.
 *
 * `submission_date` in the Orange Book is when the patent was LISTED against
 * the application, not the patent's filing or priority date, and the two can be
 * two decades apart. Passing it through as `termSettingDate` produces a
 * specific-looking date that silently means something else — and next to
 * `basis: "unknown"` there is nothing to tell the reader which it is.
 * validate.js only checks the format, so the substitution passes cleanly.
 */
function checkTermSettingDate(envelope, toolOutputs, blocking, advisory) {
  const expiry = envelope.executiveSummary?.patentExpiry;
  const stated = expiry?.termSettingDate;
  if (!stated || stated === 'unknown') return;

  const submissionDates = new Set();
  for (const t of toolOutputs) {
    if (t.tool !== 'orange_book_agent' || t.status !== 'success' || !t.output) continue;
    for (const p of t.output.patents || []) {
      const iso = normalizePatentDate(p.submission_date);
      if (iso) submissionDates.add(iso);
      if (p.submission_date) submissionDates.add(String(p.submission_date));
    }
  }

  if (submissionDates.has(String(stated))) {
    expiry.termSettingDateWarning =
      'This is an Orange Book patent submission (listing) date, not a filing or priority date.';
    blocking.push(
      `executiveSummary.patentExpiry.termSettingDate (${stated}) is an Orange Book patent ` +
        'submission date — when the patent was listed against the application, not when it was ' +
        'filed. A term calculation anchored to it is wrong by however long the listing lagged the ' +
        'filing. Use the filing or priority date, or set termSettingDate to "unknown".',
    );
    return;
  }

  if (!expiry.basis || expiry.basis === 'unknown') {
    advisory.push(
      `executiveSummary.patentExpiry.termSettingDate is ${stated} but basis is ` +
        `"${expiry.basis || 'absent'}" — a specific date is stated without saying what kind of ` +
        'date it is. State the basis (original / PTA / PTE / pediatric) or set the date to "unknown".',
    );
  }
}

/**
 * Cost and infrastructure ceilings are engineering constraints. When they
 * shrink the analysis they become analytical limitations, and the person
 * reading the verdict has to see that — a narrowed market list or an aborted
 * sweep silently determining completeness is not an acceptable failure mode.
 */
function surfaceScopeLimitations(envelope, toolOutputs, ctx, advisory) {
  const limitations = [];
  const fto = toolOutputs.find((t) => t.tool === 'patent_fto_agent' && t.status === 'success')?.output;

  const requested = ctx.requestedMarkets || envelope.targetProduct?.targetMarkets;
  const searched = fto?.coverageAttestation?.jurisdictionsSearched;
  if (Array.isArray(requested) && Array.isArray(searched)) {
    const dropped = requested.filter((m) => !searched.includes(m));
    if (dropped.length > 0) {
      limitations.push({
        kind: 'JURISDICTION',
        detail: `Markets requested but not searched: ${dropped.join(', ')}.`,
        cause: 'scope narrowed relative to the request',
      });
    }
  }

  if (fto?.sweepError) {
    limitations.push({
      kind: 'LANDSCAPE_SWEEP',
      detail:
        'The patent landscape sweep did not run; only Orange Book seed patents were classified. ' +
        'This is not a landscape search.',
      cause: fto.sweepError,
    });
  }

  if (fto?.coverageAttestation?.searchScope === 'title only') {
    limitations.push({
      kind: 'SEARCH_SCOPE',
      detail:
        'Patent discovery matched titles only; patents naming the molecule solely in the abstract ' +
        'or claims were not discovered.',
      cause: 'BigQuery column cost ceiling',
    });
  }

  const failures = toolOutputs
    .filter((t) => t.tool === 'document_reason' && t.status === 'success' && t.output)
    .flatMap((t) => t.output.retrievalFailures || []);
  if (failures.length > 0) {
    // A reissue whose text did not come back is worse than an ordinary miss:
    // a reissue can BROADEN the claims of the patent it replaces, so an
    // unreadable RE number is an unknown that can only cut against freedom to
    // operate. Call it out by name rather than letting it sit in a list.
    const reissues = failures.filter((f) => /(^|[^A-Z])RE\s*-?\d/i.test(String(f.id)));
    limitations.push({
      kind: 'CLAIM_TEXT',
      detail:
        `Claim text could not be retrieved for ${failures.length} patent(s): ${failures
          .map((f) => f.id)
          .join(', ')}. Their claim boundaries are unknown.` +
        (reissues.length > 0
          ? ` ${reissues.map((f) => f.id).join(', ')} ${reissues.length === 1 ? 'is a reissue' : 'are reissues'}` +
            ' — a reissue may broaden the claims of the patent it replaced, so this gap can only ' +
            'understate risk. Retrieve it manually before treating the FTO picture as complete.'
          : ''),
      cause: 'full-text retrieval failure',
    });
    if (reissues.length > 0) {
      envelope.openQuestions = [
        ...(envelope.openQuestions || []),
        `REISSUE CLAIM SCOPE UNKNOWN: ${reissues.map((f) => f.id).join(', ')} could not be retrieved. ` +
          'Reissues can carry broadened claims; pull the claim text manually before relying on this analysis.',
      ];
    }
  }

  if (limitations.length === 0) return;

  envelope.scopeLimitations = limitations;

  // Put it where the verdict is read, not only in an attestation object.
  const summary = envelope.executiveSummary;
  if (summary) {
    const banner =
      `[SCOPE] This analysis is incomplete in ${limitations.length} respect(s): ` +
      `${limitations.map((l) => l.detail).join(' ')} `;
    if (!String(summary.rationale || '').startsWith('[SCOPE]')) {
      summary.rationale = banner + (summary.rationale || '');
    }
  }

  advisory.push(
    `${limitations.length} scope limitation(s) surfaced into the executive summary: ` +
      `${limitations.map((l) => l.kind).join(', ')}.`,
  );
}

/**
 * Caveats derived from what the tools did and did not return.
 *
 * Model-authored openQuestions are not reproducible — the same inputs produced
 * a PTA/PTE caveat in one run and silently dropped it in the next. Anything
 * that follows deterministically from tool coverage is generated here instead,
 * so it cannot go missing between reruns. The model may still add its own.
 */
function addMandatoryCaveats(envelope, toolOutputs) {
  const caveats = [];
  const ob = toolOutputs.find((t) => t.tool === 'orange_book_agent' && t.status === 'success')?.output;
  const rldCalled = toolOutputs.some((t) => t.tool === 'rld_profile');

  if (ob?.patents?.length) {
    caveats.push(
      'PATENT TERM ADJUSTMENTS: Orange Book expiry dates are listed as-filed. PTA, PTE and ' +
        'pediatric exclusivity were not retrieved this session, so an actual expiry may fall later ' +
        'than the date shown.',
    );
  }
  if (ob && (ob.coverage?.patentsFound ?? 0) === 0) {
    caveats.push(
      'ORANGE BOOK GAP: no listed patents were returned. That is a data gap, not evidence of ' +
        'freedom to operate.',
    );
  }
  if (!rldCalled) {
    caveats.push(
      'RLD COMPOSITION NOT RETRIEVED: no rld_profile call was made, so any Q1/Q2 statement in this ' +
        'envelope is unsourced.',
    );
  }

  if (caveats.length === 0) return;

  const existing = new Set((envelope.openQuestions || []).map((q) => String(q).slice(0, 40)));
  envelope.openQuestions = [
    ...(envelope.openQuestions || []),
    ...caveats.filter((c) => !existing.has(c.slice(0, 40))),
  ];
}

/** Identifiers a successful rld_profile call actually returned. */
function rldLabelRefs(toolOutputs) {
  const refs = [];
  for (const t of toolOutputs) {
    if (t.tool !== 'rld_profile' || t.status !== 'success' || !t.output) continue;
    const r = t.output.rld || {};
    for (const v of [r.applicationNumber, r.brandName, r.splSetId]) {
      if (v) refs.push(String(v));
    }
  }
  return refs;
}

function citesRetrievedLabel(ref, labelRefs) {
  if (labelRefs.length === 0) return false;
  const normalised = normaliseRef(ref);
  return labelRefs.some((l) => normalised.includes(normaliseRef(l)));
}

/**
 * An expired patent may legitimately appear in the risk map as history, but it
 * must be labelled — an unannotated expired patent reads as a live blocker.
 */
function annotateExpiredRisks(envelope, expired, today, advisory) {
  const map = envelope.ftoRiskMap;
  if (!map || typeof map !== 'object') return;
  for (const [layer, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object') continue;
    const hits = (entry.sourceRefs || []).filter((r) => {
      const hay = normaliseRef(r);
      return [...expired].some((n) => hay.includes(normaliseRef(n)));
    });
    if (hits.length === 0) continue;
    entry.expiredSourceRefs = hits;
    entry.expiryNote = `${hits.length} cited patent(s) expired before ${today} and cannot block: ${hits.join(', ')}.`;
    advisory.push(
      `ftoRiskMap.${layer} cites ${hits.length} expired patent(s); annotated as non-blocking.`,
    );
  }
}

function normaliseRisks(envelope, advisory) {
  const map = envelope.ftoRiskMap;
  if (!map || typeof map !== 'object') return;
  for (const [layer, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object' || !('risk' in entry)) continue;
    const raw = String(entry.risk || '');
    const upper = raw.toUpperCase();
    if (RISK_LEVELS.includes(upper.trim())) {
      entry.risk = upper.trim();
      continue;
    }
    // "LOW (for ANDA 505(j)); HIGH (for 505(b)(2))" — take the highest level
    // mentioned so the headline is conservative, and keep the prose.
    const mentioned = RISK_LEVELS.filter((l) => new RegExp(`\\b${l}\\b`).test(upper));
    const worst =
      mentioned.find((l) => l === 'HIGH') ||
      mentioned.find((l) => l === 'MEDIUM') ||
      mentioned.find((l) => l === 'LOW') ||
      'UNKNOWN';
    entry.riskQualifier = raw;
    entry.risk = worst;
    advisory.push(
      `ftoRiskMap.${layer}.risk was conditional ("${raw}"); normalised to ${worst} with the original text kept in riskQualifier.`,
    );
  }
}
