/**
 * Unit normalisation for numeric comparison.
 *
 * Range checks in this domain are cross-unit far more often than not: a claim
 * says "no more than 0.1% (w/w) phenol", the label says "phenol, 5.5 mg" per
 * mL, and the question "does the RLD fall inside the claim?" is only
 * answerable once both are in the same dimension. Comparing the bare numbers
 * 0.1 and 5.5 is exactly the kind of mistake this module exists to prevent.
 *
 * Canonical concentration unit is mg/mL.
 */

const CONCENTRATION = {
  'mg/ml': 1,
  'mg/cm3': 1,
  'g/l': 1, // 1 g/L = 1 mg/mL
  'mcg/ml': 0.001,
  'ug/ml': 0.001,
  'µg/ml': 0.001,
  'mg/l': 0.001,
  'g/ml': 1000,
  'mg/100ml': 0.01,
  'g/100ml': 10,
  // % w/v is defined as g per 100 mL, so 1% w/v = 10 mg/mL.
  '%w/v': 10,
  '% w/v': 10,
};

const MASS = { ng: 1e-6, mcg: 1e-3, ug: 1e-3, 'µg': 1e-3, mg: 1, g: 1000, kg: 1e6 };
const VOLUME = { ml: 1, 'cm3': 1, l: 1000, dl: 100, 'µl': 0.001, ul: 0.001 };

/**
 * % w/w is a mass fraction, a different dimension from a concentration.
 *
 * Two mass fractions compare fine with each other. Converting one to mg/mL
 * needs the solution's density, which a patent claim almost never states —
 * silently treating "% w/w" as "% w/v" assumes a density of exactly 1 g/mL,
 * and that is how a claim gets misread as covering (or not covering) a product.
 * So it gets its own dimension and a specific refusal message.
 */
const MASS_FRACTION = /^%\s*w\s*\/\s*w$/i;

export const DIMENSION = {
  CONCENTRATION: 'concentration',
  MASS: 'mass',
  VOLUME: 'volume',
  MASS_FRACTION: 'mass fraction',
  DIMENSIONLESS: 'dimensionless',
  UNKNOWN: 'unknown',
};

function key(unit) {
  return String(unit ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** Which dimension does this unit belong to? */
export function dimensionOf(unit) {
  const k = key(unit);
  if (MASS_FRACTION.test(String(unit ?? '').trim()) || k === '%w/w') {
    return DIMENSION.MASS_FRACTION;
  }
  if (k in CONCENTRATION) return DIMENSION.CONCENTRATION;
  if (k in MASS) return DIMENSION.MASS;
  if (k in VOLUME) return DIMENSION.VOLUME;
  // A bare "%" is ambiguous in basis but perfectly comparable with another
  // bare "%", so it is dimensionless rather than unusable. Mixing it with a
  // concentration is caught by the dimension check.
  if (k === '' || k === '%' || k === 'ph' || k === 'unit' || k === 'units' || k === 'count') {
    return DIMENSION.DIMENSIONLESS;
  }
  return DIMENSION.UNKNOWN;
}

/**
 * Convert a value to its dimension's canonical unit (mg/mL, mg, mL).
 * @returns {{ok: true, value: number, unit: string, dimension: string} | {ok: false, reason: string}}
 */
export function toCanonical(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: `value ${JSON.stringify(value)} is not a finite number` };
  }
  const raw = String(unit ?? '').trim();
  const k = key(unit);
  const dimension = dimensionOf(unit);

  switch (dimension) {
    case DIMENSION.MASS_FRACTION:
      return { ok: true, value, unit: '% w/w', dimension };
    case DIMENSION.CONCENTRATION:
      return { ok: true, value: value * CONCENTRATION[k], unit: 'mg/mL', dimension };
    case DIMENSION.MASS:
      return { ok: true, value: value * MASS[k], unit: 'mg', dimension };
    case DIMENSION.VOLUME:
      return { ok: true, value: value * VOLUME[k], unit: 'mL', dimension };
    case DIMENSION.DIMENSIONLESS:
      return { ok: true, value, unit: raw || '(dimensionless)', dimension };
    default:
      return {
        ok: false,
        reason: `unit ${JSON.stringify(raw)} is not recognised. Supported: ${supportedUnits().join(', ')}.`,
      };
  }
}

export function supportedUnits() {
  return [...Object.keys(CONCENTRATION), ...Object.keys(MASS), ...Object.keys(VOLUME), '% w/v', 'pH'];
}

/**
 * Bring several (value, unit) pairs into one comparable dimension.
 * @returns {{ok: true, values: number[], unit: string, dimension: string} | {ok: false, reason: string}}
 */
export function alignUnits(pairs) {
  const converted = [];
  for (const { value, unit, label } of pairs) {
    if (value === null || value === undefined) {
      converted.push(null);
      continue;
    }
    const c = toCanonical(value, unit);
    if (!c.ok) return { ok: false, reason: `${label || 'value'}: ${c.reason}` };
    converted.push(c);
  }

  const present = converted.filter(Boolean);
  if (present.length === 0) return { ok: false, reason: 'no values supplied' };

  const dimensions = [...new Set(present.map((c) => c.dimension))];
  if (dimensions.length > 1) {
    // The domain-relevant case gets the specific explanation, because "% w/w
    // vs mg/mL" is the comparison people actually reach for.
    if (
      dimensions.includes(DIMENSION.MASS_FRACTION) &&
      dimensions.includes(DIMENSION.CONCENTRATION)
    ) {
      return {
        ok: false,
        reason:
          '% w/w is a mass fraction and cannot be converted to a concentration without the ' +
          'solution density, which was not supplied. Express both sides in the same basis ' +
          '(mg/mL or % w/v) before comparing, or supply the density.',
      };
    }
    return {
      ok: false,
      reason:
        `cannot compare across dimensions: ${dimensions.join(' vs ')}. ` +
        'Both sides of a range check must describe the same kind of quantity.',
    };
  }

  // Dimensionless values only compare when the unit strings agree, so "pH 7.4"
  // is never silently compared against "7.4 count".
  if (dimensions[0] === DIMENSION.DIMENSIONLESS) {
    const units = [...new Set(present.map((c) => c.unit.toLowerCase()))];
    if (units.length > 1) {
      return {
        ok: false,
        reason: `dimensionless units differ (${units.join(' vs ')}); refusing to compare.`,
      };
    }
  }

  return {
    ok: true,
    values: converted.map((c) => (c ? c.value : null)),
    unit: present[0].unit,
    dimension: present[0].dimension,
  };
}
