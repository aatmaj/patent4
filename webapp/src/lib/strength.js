/**
 * Strength parsing and comparison.
 *
 * A strength like "1 mg/mL" is a concentration; "1 mg/0.5 mL" is a total
 * content in a total volume, which normalises to a *different* concentration
 * (2 mg/mL). Conflating the two is how a request for one presentation silently
 * becomes an analysis of another — and for a Q1/Q2 filing the presentations
 * have different excipient profiles, so that substitution changes the answer.
 */

const MASS_TO_MG = { ng: 1e-6, mcg: 1e-3, ug: 1e-3, µg: 1e-3, mg: 1, g: 1000 };
const VOLUME_TO_ML = { ml: 1, mL: 1, l: 1000, L: 1000 };

/**
 * Parse a strength string into a normalised concentration in mg/mL where
 * possible.
 * @returns {{raw, mgPerMl: number|null, totalMg: number|null, volumeMl: number|null, kind: 'concentration'|'content-per-volume'|'mass'|'unparsed'}}
 */
export function parseStrength(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { raw, mgPerMl: null, totalMg: null, volumeMl: null, kind: 'unparsed' };

  const normalised = raw.replace(/\s+/g, ' ').replace(/per/gi, '/');

  // "4 mg / 3 mL", "1 mg/0.5 mL", "1mg/mL"
  const ratio = normalised.match(
    /([\d.]+)\s*(ng|mcg|ug|µg|mg|g)\s*\/\s*([\d.]*)\s*(ml|l)\b/i,
  );
  if (ratio) {
    const mass = Number(ratio[1]) * (MASS_TO_MG[ratio[2].toLowerCase()] ?? NaN);
    const volumeRaw = ratio[3] === '' ? 1 : Number(ratio[3]);
    const volume = volumeRaw * (VOLUME_TO_ML[ratio[4].toLowerCase()] ?? NaN);
    if (Number.isFinite(mass) && Number.isFinite(volume) && volume > 0) {
      return {
        raw,
        mgPerMl: round(mass / volume),
        totalMg: ratio[3] === '' ? null : round(mass),
        volumeMl: ratio[3] === '' ? null : round(volume),
        kind: ratio[3] === '' ? 'concentration' : 'content-per-volume',
      };
    }
  }

  // Bare mass, e.g. "500mg" — a solid dose, no concentration implied.
  const mass = normalised.match(/^([\d.]+)\s*(ng|mcg|ug|µg|mg|g)$/i);
  if (mass) {
    const mg = Number(mass[1]) * (MASS_TO_MG[mass[2].toLowerCase()] ?? NaN);
    if (Number.isFinite(mg)) {
      return { raw, mgPerMl: null, totalMg: round(mg), volumeMl: null, kind: 'mass' };
    }
  }

  return { raw, mgPerMl: null, totalMg: null, volumeMl: null, kind: 'unparsed' };
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Two concentrations match within a relative tolerance (default 1%). */
export function concentrationsMatch(a, b, tolerance = 0.01) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

/**
 * Match a requested strength against the RLD's presentations.
 *
 * Returns the matching presentation, or the candidates when there is no match,
 * so the caller can report which real presentations exist rather than
 * substituting one.
 */
export function matchPresentation(requestedStrength, presentations = []) {
  const requested = parseStrength(requestedStrength);
  const candidates = presentations
    .map((p) => ({ presentation: p, parsed: parseStrength(p.strength || p.label || '') }))
    .filter((c) => c.parsed.mgPerMl != null);

  if (requested.mgPerMl == null) {
    return {
      status: requested.kind === 'unparsed' ? 'UNPARSED' : 'NOT_A_CONCENTRATION',
      requested,
      match: null,
      candidates: candidates.map((c) => c.presentation),
    };
  }

  const exact = candidates.filter((c) =>
    concentrationsMatch(c.parsed.mgPerMl, requested.mgPerMl),
  );

  if (exact.length === 1) {
    return { status: 'MATCH', requested, match: exact[0].presentation, candidates: candidates.map((c) => c.presentation) };
  }
  if (exact.length > 1) {
    return {
      status: 'AMBIGUOUS',
      requested,
      match: null,
      matches: exact.map((c) => c.presentation),
      candidates: candidates.map((c) => c.presentation),
    };
  }
  return {
    status: 'NO_MATCH',
    requested,
    match: null,
    candidates: candidates.map((c) => c.presentation),
  };
}
