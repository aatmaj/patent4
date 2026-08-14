/**
 * Deliverable shape selection.
 *
 * FormuGraph's premise is emitting design corridors to seed a DOE. That premise
 * holds only where formulation design freedom exists. For an ANDA 505(j)
 * parenteral solution it does not: 21 CFR 314.94(a)(9)(iii) requires Q1/Q2
 * sameness, so every excipient is fixed at the RLD's concentration and every
 * "corridor" collapses to a point. A DOE generator handed that receives a
 * specification with no factors to vary.
 *
 * Rather than let the corridor schema degenerate into null bounds, this module
 * detects the case and switches the deliverable: an RLD-matched specification
 * plus the analytical and stability program that actually constitutes the
 * development work on this pathway.
 */

const PARENTERAL =
  /\b(injection|injectable|infusion|implant|subcutaneous|intravenous|intramuscular|parenteral)\b/i;
const ANDA_505J = /505\(j\)|\bANDA\b/i;
const SOLID_ORAL = /\b(tablet|capsule|granule|powder for oral)\b/i;

export const DELIVERABLE = {
  DESIGN_CORRIDORS: 'DESIGN_CORRIDORS',
  RLD_MATCHED_SPECIFICATION: 'RLD_MATCHED_SPECIFICATION',
};

/**
 * Which deliverable does this product class support?
 * @returns {{type: string, reason: string, designFreedom: 'none'|'limited'|'full'}}
 */
export function selectDeliverable({ regulatoryPathway = '', dosageForm = '' }) {
  const isAnda = ANDA_505J.test(regulatoryPathway);
  const isParenteral = PARENTERAL.test(dosageForm);

  if (isAnda && isParenteral) {
    return {
      type: DELIVERABLE.RLD_MATCHED_SPECIFICATION,
      designFreedom: 'none',
      reason:
        'ANDA 505(j) parenteral: 21 CFR 314.94(a)(9)(iii) requires the same inactive ingredients ' +
        'at the same concentrations as the RLD. Formulation design freedom is zero by regulation, ' +
        'so the deliverable is a specification to reproduce, not a design space to explore.',
    };
  }

  if (isAnda && SOLID_ORAL.test(dosageForm)) {
    return {
      type: DELIVERABLE.DESIGN_CORRIDORS,
      designFreedom: 'limited',
      reason:
        'ANDA 505(j) solid oral: Q1/Q2 sameness is not required, so excipient selection and ' +
        'levels are open subject to bioequivalence. Corridors are meaningful.',
    };
  }

  return {
    type: DELIVERABLE.DESIGN_CORRIDORS,
    designFreedom: 'full',
    reason:
      'Formulation design freedom exists on this pathway; corridors are the appropriate deliverable.',
  };
}

/** A corridor with no width carries no design information. */
export function isDegenerate(corridor) {
  const { lowerBound: lo, upperBound: hi } = corridor || {};
  if (lo == null && hi == null) return true;
  if (typeof lo === 'number' && typeof hi === 'number' && lo === hi) return true;
  return false;
}

/**
 * Build the RLD-matched specification from a retrieved rld_profile output.
 * Returns null when no composition was retrieved — the specification is then
 * genuinely unknown, and saying so is the correct output.
 */
export function buildSpecification({ rld, presentation, corridors = [] }) {
  const composition = presentation?.composition || rld?.compositions?.[0] || null;

  const excipients = (composition?.ingredients || []).map((i) => ({
    name: i.name,
    target: i.amount,
    unit: i.amount != null ? `${i.unit}/${composition.basis.replace(/\s+/g, '')}` : null,
    tolerance: i.amount != null ? 'Q1/Q2: match RLD exactly' : 'qualitative match required',
    evidenceClass: 'U1',
    sourceRef: rld?.rld?.applicationNumber
      ? `FDA label ${rld.rld.applicationNumber} (${rld.rld.brandName || 'RLD'}), Description section`
      : 'FDA label, Description section',
  }));

  const api = presentation
    ? {
        name: rld?.rld?.genericName || null,
        target: presentation.concentrationMgPerMl,
        unit: 'mg/mL',
        presentation: presentation.label,
        context: presentation.context || null,
        evidenceClass: 'U1',
        sourceRef: `FDA label ${rld?.rld?.applicationNumber || ''} Dosage Forms and Strengths`.trim(),
      }
    : null;

  if (!api && excipients.length === 0) return null;

  return {
    deliverableType: DELIVERABLE.RLD_MATCHED_SPECIFICATION,
    referenceListedDrug: {
      brandName: rld?.rld?.brandName || null,
      applicationNumber: rld?.rld?.applicationNumber || null,
      splSetId: rld?.rld?.splSetId || null,
    },
    activeIngredient: api,
    excipients,
    pH: rld?.pH?.value != null
      ? {
          target: rld.pH.value,
          tolerance: 'match RLD; confirm acceptance range against the RLD specification',
          evidenceClass: 'U1',
          sourceRef: rld.pH.raw,
        }
      : null,
    // What development work actually remains on this pathway.
    developmentProgram: {
      note:
        'Formulation composition is fixed by Q1/Q2 sameness. The development programme is ' +
        'analytical, comparative and stability work, not formulation DOE.',
      analytical: [
        'Assay and related substances method, validated per ICH Q2(R2).',
        'Comparative impurity profile against the RLD, including degradation products.',
        'Peptide-specific identity and higher-order structure comparison where applicable.',
        'Container-closure extractables and leachables programme.',
      ],
      comparative: [
        'Q1/Q2 sameness demonstration against the RLD composition below.',
        'Comparative physicochemical characterisation (pH, osmolality, viscosity, particulates per USP <787>/<788>).',
        'Device and delivered-dose comparability where the presentation includes a delivery device.',
      ],
      stability: [
        'ICH Q1A(R2) long-term and accelerated stability on the proposed commercial presentation.',
        'In-use stability covering the labelled in-use period for multi-dose presentations.',
        'Photostability per ICH Q1B.',
      ],
      openToDesign: [
        'Manufacturing process and process parameters (not constrained by Q1/Q2).',
        'Container-closure system, subject to comparability.',
        'Any process-related design of experiments — this is where DOE effort belongs on this pathway.',
      ],
    },
    supersededCorridors: corridors.filter(isDegenerate).map((c) => c.parameter),
  };
}
