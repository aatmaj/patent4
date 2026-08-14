import { runQuery } from '../bigquery.js';
import { createMessage, textOf } from '../gemini.js';
import { MODEL, UTILITY_MODEL } from '../config.js';

/**
 * PhysChem agent.
 * S1: ChEMBL compound_properties + molecule_dictionary from BigQuery.
 * U2: Claude annotation over those S1 values (BCS candidate, liabilities).
 */
export async function physchem({ moleculeId, moleculeName }) {
  if (!moleculeId && !moleculeName) {
    const err = new Error(
      'Provide moleculeId (molregno or chembl_id) or moleculeName',
    );
    err.status = 400;
    throw err;
  }

  // Parameterised. These values reach here from an LLM tool call whose input
  // originates with the user, so interpolating them into SQL is injectable.
  const sql = moleculeId
    ? `
      SELECT
        md.molregno, md.pref_name, md.chembl_id, md.max_phase,
        md.therapeutic_flag, md.molecule_type,
        cp.mw_freebase, cp.alogp, cp.psa, cp.rtb, cp.hba, cp.hbd,
        cp.num_ro5_violations
      FROM \`patents-public-data.ebi_chembl.molecule_dictionary\` md
      LEFT JOIN \`patents-public-data.ebi_chembl.compound_properties\` cp
        ON md.molregno = cp.molregno
      WHERE CAST(md.molregno AS STRING) = @moleculeId OR md.chembl_id = @moleculeId
      LIMIT 5
    `
    : `
      SELECT
        md.molregno, md.pref_name, md.chembl_id, md.max_phase,
        md.therapeutic_flag, md.molecule_type,
        cp.mw_freebase, cp.alogp, cp.psa, cp.rtb, cp.hba, cp.hbd,
        cp.num_ro5_violations
      FROM \`patents-public-data.ebi_chembl.molecule_dictionary\` md
      LEFT JOIN \`patents-public-data.ebi_chembl.compound_properties\` cp
        ON md.molregno = cp.molregno
      WHERE LOWER(md.pref_name) LIKE LOWER(CONCAT('%', @moleculeName, '%'))
      LIMIT 5
    `;

  const params = moleculeId ? { moleculeId: String(moleculeId) } : { moleculeName };
  const rows = await runQuery(sql, params);

  if (!rows || rows.length === 0) {
    return {
      status: 'notFound',
      message: `No ChEMBL record found for: ${moleculeId || moleculeName}`,
      properties: [],
      evidenceClass: 'S1',
    };
  }

  const raw = rows[0];

  const s1Properties = [
    prop('molecular_weight', raw.mw_freebase, 'Da', 'measured', 'S1', 0.95),
    prop('alogp', raw.alogp, 'logP units', 'predicted', 'S1', 0.9),
    prop('psa', raw.psa, 'A^2', 'predicted', 'S1', 0.9),
    prop('rotatable_bonds', raw.rtb, 'count', 'measured', 'S1', 0.99),
    prop('hba', raw.hba, 'count', 'measured', 'S1', 0.99),
    prop('hbd', raw.hbd, 'count', 'measured', 'S1', 0.99),
    prop('lipinski_violations', raw.num_ro5_violations, 'count', 'derived', 'S2', 0.99),
    prop('max_clinical_phase', raw.max_phase, 'phase', 'label', 'S1', 0.99),
  ]
    .filter((p) => p.value !== null && p.value !== undefined)
    .map((p) => ({ ...p, sourceRef: `ChEMBL:${raw.chembl_id}` }));

  const annotation = await annotate(raw, s1Properties);

  return {
    molecule: {
      molregno: raw.molregno,
      prefName: raw.pref_name,
      chemblId: raw.chembl_id,
      maxPhase: raw.max_phase,
      therapeuticFlag: raw.therapeutic_flag,
      moleculeType: raw.molecule_type,
    },
    properties: s1Properties,
    // Exact S1 values, so the orchestrator can copy them into the envelope
    // verbatim instead of re-typing (and rounding) them from prose.
    //
    // `coverage` explains an all-null result. ChEMBL's compound_properties
    // table only covers small molecules, so a peptide or protein legitimately
    // has no row — without saying so, a silent set of nulls invites the model
    // to fill them from recall.
    coverage: describeCoverage(raw),
    canonicalValues: {
      Mw: numberOrNull(raw.mw_freebase),
      logP: numberOrNull(raw.alogp),
      psa: numberOrNull(raw.psa),
      hba: numberOrNull(raw.hba),
      hbd: numberOrNull(raw.hbd),
      ro5Violations: numberOrNull(raw.num_ro5_violations),
    },
    annotation: {
      ...annotation,
      evidenceClass: 'U2',
      sourceRef: `${MODEL}:annotation`,
      confidence: 0.65,
      note: 'BCS class is a candidate based on ALogP and MW; not a regulatory classification.',
    },
    provenance: {
      s1Source: 'patents-public-data.ebi_chembl',
      retrievedAt: new Date().toISOString(),
      sql,
      params,
    },
  };
}

function describeCoverage(raw) {
  const hasProps =
    raw.mw_freebase != null || raw.alogp != null || raw.psa != null;
  const type = String(raw.molecule_type || '').toLowerCase();
  const isMacromolecule = /protein|antibody|peptide|oligo|unknown/.test(type);

  if (hasProps) {
    return { propertiesAvailable: true, note: 'Physicochemical properties returned by ChEMBL.' };
  }
  return {
    propertiesAvailable: false,
    moleculeType: raw.molecule_type || null,
    note: isMacromolecule
      ? `ChEMBL holds no compound_properties row for this molecule (molecule_type "${raw.molecule_type}"). ` +
        'That table covers small molecules; Mw, logP and PSA are genuinely UNAVAILABLE from this source. ' +
        'Emit null, or take the molecular weight from the FDA label via rld_profile (which states it) — ' +
        'do not supply these values from recall.'
      : 'ChEMBL returned no compound_properties row for this molecule. Emit null rather than recalling values.',
  };
}

function prop(property, value, unit, method, evidenceClass, confidence) {
  return { property, value: numberOrNull(value), unit, method, evidenceClass, confidence };
}

function numberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function annotate(raw, s1Properties) {
  const prompt = `You are a pharmaceutical scientist. Given these measured properties, provide a structured annotation.
Properties: ${JSON.stringify(s1Properties)}
Molecule: ${raw.pref_name} (${raw.chembl_id}), type: ${raw.molecule_type || 'unknown'}

Return ONLY this JSON object, no other text:
{
  "bcsClassCandidate": "I|II|III|IV|unknown",
  "bcsRationale": "one sentence",
  "stabilityLiabilities": ["general chemical stability risks only"],
  "hygroscopicityRisk": "low|medium|high|unknown",
  "particleSizeSensitivity": "low|medium|high|unknown",
  "formulationChallenges": ["list"]
}

Do not assert sequence-specific liabilities (e.g. methionine oxidation, deamidation of a named residue) — the sequence was not provided to you. Restrict stabilityLiabilities to risks inferable from the properties above and the molecule type.`;

  try {
    const response = await createMessage({
      model: UTILITY_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    const clean = textOf(response)
      .trim()
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const match = clean.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'parse_failed' };
  } catch (err) {
    // An annotation failure must not fail the S1 retrieval — the structured
    // properties are the valuable part and are already in hand.
    return { error: 'annotation_failed', message: err.message };
  }
}
