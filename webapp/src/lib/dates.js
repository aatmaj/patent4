/**
 * Date normalisation for patent data.
 *
 * BigQuery's `patents-public-data.patents.publications` stores filing_date,
 * grant_date and publication_date as INT64 in YYYYMMDD form (e.g. 20150612),
 * and openFDA's Orange Book uses the same encoding as a string ("20340502").
 *
 * Passing either straight to `new Date()` is silently wrong: `new Date(20150612)`
 * is interpreted as epoch milliseconds and yields 1970-08-21, which then
 * produces a patent expiry ~55 years early with no error raised.
 */

/** Lower bound for a plausible patent date. Anything earlier is a parse failure. */
const MIN_YEAR = 1790; // first US patent act
const MAX_YEAR = 2200;

/**
 * Normalise a patent date into YYYY-MM-DD.
 * Accepts: 20150612 (number), "20150612", "2015-06-12", "2015/06/12", Date,
 * and BigQuery's {value: "2015-06-12"} wrapper.
 * Returns null when the input cannot be interpreted as a real calendar date.
 */
export function normalizePatentDate(input) {
  if (input === null || input === undefined || input === '') return null;

  // BigQuery date/timestamp wrapper objects
  if (typeof input === 'object' && !(input instanceof Date) && input.value != null) {
    return normalizePatentDate(input.value);
  }

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return clampToPlausible(input.toISOString().slice(0, 10));
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // YYYYMMDD (the BigQuery / openFDA encoding)
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return validate(compact[1], compact[2], compact[3]);

  // YYYY-MM-DD or YYYY/MM/DD
  const dashed = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (dashed) {
    return validate(dashed[1], dashed[2].padStart(2, '0'), dashed[3].padStart(2, '0'));
  }

  // Anything else: refuse rather than guess. A wrong date here becomes an
  // S2-labelled expiry that looks authoritative.
  return null;
}

function validate(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  // Rejects 2015-02-30 and friends, which Date would roll forward.
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

function clampToPlausible(iso) {
  const year = Number(iso.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return iso;
}

/** Normalise to YYYYMMDD for string comparison against openFDA fields. */
export function toCompact(input) {
  const iso = normalizePatentDate(input);
  return iso ? iso.replace(/-/g, '') : null;
}

/** Add whole years to a YYYY-MM-DD date, preserving month/day. */
export function addYears(iso, years) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y + years, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

/** Add days (may be fractional; rounded to the nearest whole day). */
export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Math.round(days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Add whole months, clamping to the last day of the target month so that
 * e.g. 2024-01-31 + 1 month is 2024-02-29, not 2024-03-02.
 */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(targetYear, targetMonth, Math.min(d, lastDay)));
  return dt.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a, b) {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}
