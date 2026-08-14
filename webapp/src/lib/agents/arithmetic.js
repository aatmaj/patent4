import { alignUnits, toCanonical } from '../units.js';
import {
  normalizePatentDate,
  addYears,
  addDays,
  addMonths,
  daysBetween,
} from '../dates.js';

/**
 * Arithmetic agent — deterministic, no LLM.
 * All results are evidenceClass S2 (derived by arithmetic from S1 inputs).
 */

const MAX_PTE_YEARS = 5; // 35 USC 156 caps patent term extension at 5 years
const PEDIATRIC_MONTHS = 6;

export function arithmetic(body) {
  const { operation, params = {} } = body || {};
  const expression = params.expression ?? body?.expression;

  switch (operation) {
    case 'patent_expiry':
      return patentExpiry(params);
    case 'unit_convert':
      return unitConvert(params);
    case 'days_until':
      return daysUntil(params);
    case 'min':
    case 'max':
    case 'earliest':
    case 'latest':
      return extremum(operation, params);
    case 'in_range':
      return inRange(params);
    case 'compare':
      return compare(params);
    case 'overlap':
      return overlap(params);
    case 'eval':
      return evaluate(expression);
    default:
      throw new Error(
        `Unknown operation: ${operation}. Expected one of: in_range, compare, overlap, ` +
          `patent_expiry, unit_convert, days_until, min, max, earliest, latest, eval.`,
      );
  }
}

function patentExpiry(params) {
  const {
    filingDate,
    filing_date,
    pte,
    pte_years,
    pte_days,
    patent_term_extension_days,
    pta,
    pta_days,
    pediatric = false,
  } = params;

  const rawFiling = filingDate ?? filing_date;
  if (rawFiling === undefined || rawFiling === null || rawFiling === '') {
    throw new Error(
      'filingDate is required for patent expiry (35 USC 154 runs term from the ' +
        'earliest non-provisional filing date; priorityDate cannot be used).',
    );
  }

  // BigQuery hands back YYYYMMDD integers. Normalising here is what stops
  // `new Date(20150612)` silently producing a 1970 base date.
  const base = normalizePatentDate(rawFiling);
  if (!base) {
    throw new Error(
      `Could not interpret filingDate ${JSON.stringify(rawFiling)} as a calendar date. ` +
        'Expected YYYYMMDD or YYYY-MM-DD.',
    );
  }

  // Coalesce the several spellings the orchestrator has used. PTE is granted
  // by FDA in days, so days are preferred; a year figure is converted only as
  // a fallback.
  const baseTerm = addYears(base, 20);

  // The statutory ceiling is five *calendar* years (35 USC 156(g)(6)), which
  // is 1826 or 1827 days depending on how many leap days it spans. Deriving
  // it from the calendar keeps the cap exact instead of drifting by a day.
  const maxPteDays = daysBetween(baseTerm, addYears(baseTerm, MAX_PTE_YEARS));

  const requestedPteDays = firstPositive([
    pte_days,
    patent_term_extension_days,
    pte != null ? pte * 365.25 : undefined,
    pte_years != null ? pte_years * 365.25 : undefined,
  ]);
  const pteDays = Math.min(Math.round(requestedPteDays), maxPteDays);
  const pteCapped = Math.round(requestedPteDays) > maxPteDays;

  const ptaDays = Math.round(firstPositive([pta, pta_days]));

  let result = baseTerm;
  if (pteDays > 0) result = addDays(result, pteDays);
  if (ptaDays > 0) result = addDays(result, ptaDays);
  // Pediatric exclusivity is six calendar months, not 182.6 days.
  if (pediatric) result = addMonths(result, PEDIATRIC_MONTHS);

  const notes = [];
  if (pteCapped) {
    notes.push(
      `Requested PTE of ${Math.round(requestedPteDays)} days exceeds the 5-year statutory cap ` +
        `(35 USC 156(g)(6)); capped at ${maxPteDays} days.`,
    );
  }

  return {
    result,
    derivation:
      `filingDate(${base}) + 20y` +
      (pteDays > 0 ? ` + PTE(${pteDays}d)` : '') +
      (ptaDays > 0 ? ` + PTA(${ptaDays}d)` : '') +
      (pediatric ? ` + pediatric(${PEDIATRIC_MONTHS}m)` : '') +
      ` = ${result}`,
    inputs: { filingDate: base, pteDays, ptaDays, pediatric, maxPteDays },
    notes,
    evidenceClass: 'S2',
  };
}

function firstPositive(candidates) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
  }
  return 0;
}

const CONVERSIONS = {
  mg_to_g: 0.001,
  g_to_mg: 1000,
  nm_to_um: 0.001,
  um_to_nm: 1000,
  pa_to_mpa: 0.000001,
  mpa_to_pa: 1000000,
};

function unitConvert({ value, from, to }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('unit_convert requires a numeric `value`.');
  }
  if (!from || !to) throw new Error('unit_convert requires `from` and `to`.');

  const key = `${String(from).toLowerCase()}_to_${String(to).toLowerCase()}`;
  let result;
  if (CONVERSIONS[key] !== undefined) {
    result = value * CONVERSIONS[key];
  } else {
    // Fall back to the shared unit table so concentration conversions work too.
    const src = toCanonical(value, from);
    const dst = toCanonical(1, to);
    if (!src.ok || !dst.ok || src.dimension !== dst.dimension) {
      throw new Error(
        `Unknown conversion: ${from} to ${to}. ` +
          (src.ok ? '' : `${src.reason} `) +
          `Supported shorthands: ${Object.keys(CONVERSIONS).join(', ')}.`,
      );
    }
    result = src.value / dst.value;
  }
  return {
    result,
    derivation: `${value} ${from} = ${result} ${to}`,
    evidenceClass: 'S2',
  };
}

function daysUntil({ targetDate }) {
  const iso = normalizePatentDate(targetDate);
  if (!iso) {
    throw new Error(
      `Could not interpret targetDate ${JSON.stringify(targetDate)} as a calendar date.`,
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  const result = Math.round(ms / 86_400_000);
  return {
    result,
    derivation: `(${iso} - ${today}) = ${result} days`,
    evidenceClass: 'S2',
  };
}

/**
 * Bounded numeric comparison — the operations that back a *verdict*.
 *
 * These exist because range containment was the one class of numeric judgment
 * with no deterministic backing anywhere in the pipeline. Across 16 recorded
 * runs the arithmetic tool was called 17 times — for expiry dates, extremes and
 * bare expressions — and not once for "is this value inside that claimed
 * range?", which is the question that actually decides whether a patent reads
 * on a product. That judgment was being made in prose, inside the same
 * generation pass doing the legal reasoning, and it got the answer wrong.
 *
 * Every result is S2: derived deterministically from inputs the caller supplies.
 * The response carries the normalised operands so a harness can verify that a
 * given assertion was actually backed by a comparison over the right numbers.
 */
function inRange(params) {
  const {
    value,
    lower = null,
    upper = null,
    unit,
    valueUnit = unit,
    lowerUnit = unit,
    upperUnit = unit,
    lowerInclusive = true,
    upperInclusive = true,
    label,
  } = params;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('in_range requires a finite numeric `value`.');
  }
  if (lower === null && upper === null) {
    throw new Error('in_range requires at least one of `lower` or `upper`.');
  }

  const aligned = alignUnits([
    { value, unit: valueUnit, label: 'value' },
    { value: lower, unit: lowerUnit, label: 'lower' },
    { value: upper, unit: upperUnit, label: 'upper' },
  ]);
  if (!aligned.ok) throw new Error(`in_range: ${aligned.reason}`);

  const [v, lo, hi] = aligned.values;
  const belowLower = lo !== null && (lowerInclusive ? v < lo : v <= lo);
  const aboveUpper = hi !== null && (upperInclusive ? v > hi : v >= hi);
  const within = !belowLower && !aboveUpper;
  const relation = belowLower ? 'below' : aboveUpper ? 'above' : 'within';

  const bounds =
    `${lo !== null ? `${lo}${lowerInclusive ? ' <=' : ' <'} ` : ''}` +
    `${v}` +
    `${hi !== null ? ` ${upperInclusive ? '<=' : '<'} ${hi}` : ''}`;

  return {
    result: within,
    inRange: within,
    relation,
    // Normalised operands, so a verdict can be traced to the numbers it used.
    normalized: { value: v, lower: lo, upper: hi, unit: aligned.unit },
    inputs: { value, lower, upper, valueUnit, lowerUnit, upperUnit, lowerInclusive, upperInclusive },
    label: label ?? null,
    derivation:
      `in_range(${bounds} in ${aligned.unit}) = ${within} (${relation})` +
      (aligned.unit !== String(valueUnit ?? '') ? ` [normalised from ${valueUnit ?? 'unitless'}]` : ''),
    evidenceClass: 'S2',
  };
}

function compare(params) {
  const { a, b, unit, aUnit = unit, bUnit = unit, label } = params;
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error('compare requires finite numeric `a` and `b`.');
  }
  const aligned = alignUnits([
    { value: a, unit: aUnit, label: 'a' },
    { value: b, unit: bUnit, label: 'b' },
  ]);
  if (!aligned.ok) throw new Error(`compare: ${aligned.reason}`);

  const [x, y] = aligned.values;
  const relation = x < y ? 'lt' : x > y ? 'gt' : 'eq';
  const symbol = { lt: '<', gt: '>', eq: '=' }[relation];

  return {
    result: relation,
    relation,
    normalized: { a: x, b: y, unit: aligned.unit },
    inputs: { a, b, aUnit, bUnit },
    label: label ?? null,
    derivation: `compare(${x} ${symbol} ${y} in ${aligned.unit}) = ${relation}`,
    evidenceClass: 'S2',
  };
}

/**
 * Do two ranges overlap? This is the claim-scope question: a product range and
 * a claimed range that do not intersect cannot infringe on that limitation.
 */
function overlap(params) {
  const { aLower = null, aUpper = null, bLower = null, bUpper = null, unit, aUnit = unit, bUnit = unit, label } =
    params;

  const aligned = alignUnits([
    { value: aLower, unit: aUnit, label: 'aLower' },
    { value: aUpper, unit: aUnit, label: 'aUpper' },
    { value: bLower, unit: bUnit, label: 'bLower' },
    { value: bUpper, unit: bUnit, label: 'bUpper' },
  ]);
  if (!aligned.ok) throw new Error(`overlap: ${aligned.reason}`);

  const [al, au, bl, bu] = aligned.values;
  const aLo = al ?? -Infinity;
  const aHi = au ?? Infinity;
  const bLo = bl ?? -Infinity;
  const bHi = bu ?? Infinity;

  const lo = Math.max(aLo, bLo);
  const hi = Math.min(aHi, bHi);
  const overlaps = lo <= hi;

  return {
    result: overlaps,
    overlaps,
    intersection: overlaps
      ? { lower: Number.isFinite(lo) ? lo : null, upper: Number.isFinite(hi) ? hi : null, unit: aligned.unit }
      : null,
    normalized: { aLower: al, aUpper: au, bLower: bl, bUpper: bu, unit: aligned.unit },
    inputs: { aLower, aUpper, bLower, bUpper, aUnit, bUnit },
    label: label ?? null,
    derivation:
      `overlap([${aLo}, ${aHi}], [${bLo}, ${bHi}] in ${aligned.unit}) = ${overlaps}` +
      (overlaps ? ` (intersection [${lo}, ${hi}])` : ''),
    evidenceClass: 'S2',
  };
}

/**
 * min / max over a list of numbers, and earliest / latest over a list of dates.
 *
 * "Earliest blocking expiry" is a routine question here, and routing it through
 * `eval` was never going to work: the expression guard rejects brackets and
 * commas by design. Aggregation over a list is safe because nothing is
 * evaluated — the values are parsed, not executed.
 */
function extremum(operation, params) {
  const values = params.values ?? params.dates ?? params.list ?? params.items;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      `${operation} requires a non-empty \`values\` array (numbers, or dates as YYYYMMDD / YYYY-MM-DD).`,
    );
  }
  if (values.length > 500) throw new Error(`${operation} accepts at most 500 values.`);

  const wantEarliestLatest = operation === 'earliest' || operation === 'latest';
  const wantMin = operation === 'min' || operation === 'earliest';

  // Dates first: a bare 20340502 is a date in this domain, not the integer
  // twenty million, so date interpretation takes precedence when it succeeds
  // for every element.
  const asDates = values.map((v) => normalizePatentDate(v));
  const allDates = asDates.every((d) => d !== null);

  if (allDates) {
    const pairs = values.map((v, i) => ({ input: v, iso: asDates[i] }));
    const sorted = [...pairs].sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
    const picked = wantMin ? sorted[0] : sorted[sorted.length - 1];
    return {
      result: picked.iso,
      selectedFrom: picked.input,
      count: values.length,
      sorted: sorted.map((p) => p.iso),
      derivation: `${operation}(${sorted.map((p) => p.iso).join(', ')}) = ${picked.iso}`,
      evidenceClass: 'S2',
    };
  }

  if (wantEarliestLatest) {
    const bad = values.filter((v, i) => asDates[i] === null);
    throw new Error(
      `${operation} requires every value to be a date. Could not interpret: ${JSON.stringify(bad.slice(0, 5))}.`,
    );
  }

  const numbers = values.map(Number);
  if (!numbers.every((n) => Number.isFinite(n))) {
    const bad = values.filter((_, i) => !Number.isFinite(numbers[i]));
    throw new Error(
      `${operation} requires numbers or dates. Could not interpret: ${JSON.stringify(bad.slice(0, 5))}.`,
    );
  }
  const result = wantMin ? Math.min(...numbers) : Math.max(...numbers);
  return {
    result,
    count: numbers.length,
    derivation: `${operation}(${numbers.join(', ')}) = ${result}`,
    evidenceClass: 'S2',
  };
}

// Digits, whitespace and the four operators plus parentheses. Anything else —
// identifiers, property access, template syntax — is refused before it reaches
// the Function constructor. Aggregation over lists is handled by min/max/
// earliest/latest above rather than by loosening this.
const SAFE_EXPRESSION = /^[\d\s+\-*/.()]+$/;

function evaluate(expression) {
  if (!expression) throw new Error('`expression` is required for eval.');
  if (typeof expression !== 'string') {
    throw new Error('`expression` must be a string.');
  }
  if (expression.length > 200) {
    throw new Error('`expression` is too long (max 200 characters).');
  }
  if (!SAFE_EXPRESSION.test(expression)) {
    throw new Error(
      'Expression contains characters outside [0-9 + - * / . ( )] — refused for safety.',
    );
  }

  const result = Function(`"use strict"; return (${expression});`)();
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`Expression did not evaluate to a finite number: ${expression}`);
  }

  return {
    result,
    derivation: `eval(${expression}) = ${result}`,
    evidenceClass: 'S2',
  };
}
