/**
 * Envelope shape validation.
 *
 * The previous check only asserted that five top-level keys existed, so nested
 * shape drift passed silently — an envelope emitting
 * `patentExpiry.latestFormulationExpiry` instead of `patentExpiry.date`
 * validated cleanly and then rendered as "unknown" in the UI, discarding the
 * date the model had actually produced.
 *
 * Returns an array of human-readable errors, written to be actionable when fed
 * back to the model for repair.
 */

const REQUIRED_TOP = [
  'executiveSummary',
  'ftoRiskMap',
  'designCorridors',
  'constraintsForDOE',
  'verification',
];

const PHASES = [
  'phase0_normalize',
  'phase1_fto',
  'phase2_physchem',
  'phase3_crossDomainFusion',
  'phase4_envelopeAdaptation',
  'phase5_emit',
  'phase6_selfVerify',
];

const STATUSES = ['GO', 'NO_GO', 'REVIEW', 'ABORTED_NO_DATA'];
const ZONE_TYPES = ['PERMITTED', 'EXCLUDED'];
const EVIDENCE_CLASSES = ['S1', 'S2', 'U1', 'U2', 'I'];
const RISK_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

export function validateEnvelope(env) {
  const errors = [];
  if (!env || typeof env !== 'object') {
    return ['Envelope is not an object.'];
  }

  for (const key of REQUIRED_TOP) {
    if (!env[key]) errors.push(`Missing required key: developmentConstraintEnvelope.${key}`);
  }

  // executiveSummary
  const summary = env.executiveSummary;
  if (summary) {
    if (!STATUSES.includes(summary.status)) {
      errors.push(
        `executiveSummary.status must be one of ${STATUSES.join(' | ')} — got ${JSON.stringify(summary.status)}.`,
      );
    }
    const expiry = summary.patentExpiry;
    if (expiry !== undefined && expiry !== null) {
      if (typeof expiry !== 'object') {
        errors.push('executiveSummary.patentExpiry must be an object.');
      } else {
        if (typeof expiry.date !== 'string' || !expiry.date) {
          errors.push(
            'executiveSummary.patentExpiry.date is required (YYYY-MM-DD or "unknown"). ' +
              'Do not rename this field — additional detail belongs in extra fields alongside it, not instead of it.',
          );
        } else if (!/^(\d{4}-\d{2}-\d{2}|unknown)$/.test(expiry.date)) {
          errors.push(
            `executiveSummary.patentExpiry.date must be YYYY-MM-DD or "unknown" — got ${JSON.stringify(expiry.date)}.`,
          );
        }
        if (
          expiry.termSettingDate !== undefined &&
          expiry.termSettingDate !== null &&
          !/^(\d{4}-\d{2}-\d{2}|unknown)$/.test(String(expiry.termSettingDate))
        ) {
          errors.push(
            'executiveSummary.patentExpiry.termSettingDate must be YYYY-MM-DD or "unknown" — got ' +
              `${JSON.stringify(expiry.termSettingDate)}. A patent number belongs in its own field ` +
              '(termSettingPatent), not here.',
          );
        }
        if (expiry.basis === undefined) {
          errors.push(
            'executiveSummary.patentExpiry.basis is required (original | continuation-parent | PCT | unknown).',
          );
        }
      }
    }
  }

  // designCorridors
  if (env.designCorridors !== undefined) {
    if (!Array.isArray(env.designCorridors)) {
      errors.push('designCorridors must be an array.');
    } else {
      env.designCorridors.forEach((c, i) => {
        const at = `designCorridors[${i}]`;
        if (!c || typeof c !== 'object') {
          errors.push(`${at} must be an object.`);
          return;
        }
        if (!c.parameter) errors.push(`${at}.parameter is required.`);
        if (!ZONE_TYPES.includes(c.zoneType)) {
          errors.push(
            `${at}.zoneType must be PERMITTED or EXCLUDED — got ${JSON.stringify(c.zoneType)}.`,
          );
        }
        for (const bound of ['lowerBound', 'upperBound']) {
          const v = c[bound];
          if (v === null || v === undefined) continue;
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(
              `${at}.${bound} must be a JSON number, not a string — got ${JSON.stringify(v)}.`,
            );
          }
        }
        if (
          typeof c.lowerBound === 'number' &&
          typeof c.upperBound === 'number' &&
          c.lowerBound > c.upperBound
        ) {
          errors.push(`${at}: lowerBound (${c.lowerBound}) exceeds upperBound (${c.upperBound}).`);
        }
        if (!EVIDENCE_CLASSES.includes(c.evidenceClass)) {
          errors.push(
            `${at}.evidenceClass must be one of ${EVIDENCE_CLASSES.join(' | ')} — got ${JSON.stringify(c.evidenceClass)}.`,
          );
        }
        if (c.evidenceClass === 'S1') {
          errors.push(`${at}.evidenceClass cannot be S1: a corridor is interpretive, not a query result.`);
        }
        if (c.rldMatched !== undefined && typeof c.rldMatched !== 'boolean') {
          errors.push(
            `${at}.rldMatched must be true, false, or omitted — got ${JSON.stringify(c.rldMatched)}.`,
          );
        }
      });
    }
  }

  // constraintsForDOE
  if (env.constraintsForDOE !== undefined) {
    if (!Array.isArray(env.constraintsForDOE)) {
      errors.push('constraintsForDOE must be an array.');
    } else {
      env.constraintsForDOE.forEach((c, i) => {
        const at = `constraintsForDOE[${i}]`;
        if (!c || typeof c !== 'object') {
          errors.push(`${at} must be an object.`);
          return;
        }
        if (!['EXCLUSION', 'REQUIREMENT'].includes(c.type)) {
          errors.push(`${at}.type must be EXCLUSION or REQUIREMENT — got ${JSON.stringify(c.type)}.`);
        }
        if (!c.description) errors.push(`${at}.description is required.`);
        if (!EVIDENCE_CLASSES.includes(c.evidenceClass)) {
          errors.push(
            `${at}.evidenceClass must be one of ${EVIDENCE_CLASSES.join(' | ')} — got ${JSON.stringify(c.evidenceClass)}.`,
          );
        }
      });
    }
  }

  // ftoRiskMap
  if (env.ftoRiskMap && typeof env.ftoRiskMap === 'object') {
    for (const [layer, entry] of Object.entries(env.ftoRiskMap)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!('risk' in entry)) {
        errors.push(`ftoRiskMap.${layer}.risk is required.`);
        continue;
      }
      const upper = String(entry.risk).toUpperCase();
      const mentionsLevel = RISK_LEVELS.some((l) => upper.includes(l));
      if (!mentionsLevel) {
        errors.push(
          `ftoRiskMap.${layer}.risk must state one of ${RISK_LEVELS.join(' | ')} — got ${JSON.stringify(entry.risk)}. ` +
            'If the risk is conditional, put the level first and the condition in a separate note.',
        );
      }
    }
  }

  // verification
  if (env.verification) {
    if (typeof env.verification !== 'object') {
      errors.push('verification must be an object.');
    } else {
      for (const phase of PHASES) {
        const p = env.verification[phase];
        if (!p) {
          errors.push(`verification.${phase} is required (exact key spelling).`);
          continue;
        }
        if (!['PASS', 'FAIL'].includes(p.status)) {
          errors.push(`verification.${phase}.status must be PASS or FAIL — got ${JSON.stringify(p.status)}.`);
        }
        if (p.conflicts !== undefined && !Array.isArray(p.conflicts)) {
          errors.push(`verification.${phase}.conflicts must be an array of strings.`);
        }
      }
    }
  }

  return errors;
}
