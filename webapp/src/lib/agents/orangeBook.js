import { HTTP_TIMEOUT_MS } from '../config.js';
import { normalizePatentDate } from '../dates.js';

/**
 * Orange Book agent — FDA approvals, listed patents and exclusivities.
 *
 * Source: openFDA `drug/orangebook`. Records carry `patents[]` and
 * `exclusivity[]`, both with dates in YYYYMMDD form. Not every record has
 * them, so `patentsFound: 0` is reported explicitly rather than being left to
 * look like "this molecule has no patents".
 */
const ENDPOINT = 'https://api.fda.gov/drug/orangebook.json';

export async function orangeBook({ molecule }) {
  if (!molecule || typeof molecule !== 'string' || !molecule.trim()) {
    const err = new Error('molecule is required');
    err.status = 400;
    throw err;
  }

  const name = molecule.trim();
  // openFDA's Lucene syntax needs the phrase quoted; the whole term must then
  // be URL-encoded or a molecule containing a space or quote breaks the query.
  const search =
    `products.active_ingredients.name:"${escapeLucene(name)}"` +
    ` OR products.brand_name:"${escapeLucene(name)}"`;
  const url = `${ENDPOINT}?search=${encodeURIComponent(search)}&limit=100`;

  const response = await fetchJson(url);

  // openFDA signals "nothing matched" with HTTP 404 + error.code NOT_FOUND.
  if (response.status === 404) {
    return {
      status: 'NO_DATA',
      source: 'openFDA Orange Book API',
      message: `No Orange Book records found for ${name}`,
      patents: [],
      exclusivities: [],
      products: [],
      coverage: { recordsMatched: 0, patentsFound: 0, exclusivitiesFound: 0 },
      evidenceClass: 'S1',
    };
  }

  const data = response.body;
  if (data?.error) {
    throw new Error(
      `openFDA error ${data.error.code || response.status}: ${data.error.message || 'unknown'}`,
    );
  }
  if (!response.ok) {
    throw new Error(`openFDA returned HTTP ${response.status}`);
  }

  const results = Array.isArray(data?.results) ? data.results : [];

  const patents = [];
  const exclusivities = [];
  const products = [];
  const seenPatents = new Set();
  const seenExclusivities = new Set();

  for (const record of results) {
    for (const p of record.patents || []) {
      if (!p.patent_number || seenPatents.has(p.patent_number)) continue;
      seenPatents.add(p.patent_number);
      patents.push({
        patent_number: p.patent_number,
        expiration_date: p.expiration_date || null,
        expiration_date_iso: normalizePatentDate(p.expiration_date),
        drug_product_flag: p.drug_product_flag ?? null,
        drug_substance_flag: p.drug_substance_flag ?? null,
        patent_use_code: p.patent_use_code || null,
        submission_date: p.patent_submission_date || null,
      });
    }

    for (const e of record.exclusivity || []) {
      const key = `${e.exclusivity_code}-${e.exclusivity_expiration_date}`;
      if (seenExclusivities.has(key)) continue;
      seenExclusivities.add(key);
      exclusivities.push({
        exclusivity_code: e.exclusivity_code || null,
        exclusivity_expiration_date: e.exclusivity_expiration_date || null,
        exclusivity_expiration_date_iso: normalizePatentDate(
          e.exclusivity_expiration_date,
        ),
      });
    }

    for (const p of record.products || []) {
      products.push({
        brand_name: p.brand_name || null,
        dosage_form: p.dosage_form || null,
        route: p.route || null,
        marketing_status: p.marketing_status || null,
        application_number: p.application_number || null,
        approval_date: record.approval_date || null,
        approval_date_iso: normalizePatentDate(record.approval_date),
        reference_listed_drug: p.reference_listed_drug ?? null,
      });
    }
  }

  return {
    status: 'SUCCESS',
    source: 'openFDA Orange Book API',
    patents,
    exclusivities,
    products,
    coverage: {
      recordsMatched: results.length,
      patentsFound: patents.length,
      exclusivitiesFound: exclusivities.length,
      // Made explicit so the orchestrator cannot read an empty array as
      // "searched and found none" when the records simply carry no patent block.
      note:
        patents.length === 0
          ? 'Matched Orange Book records contain no listed patents. This is a DATA GAP, not evidence that the molecule is unencumbered.'
          : 'Patent and exclusivity data as listed in the FDA Orange Book.',
    },
    evidenceClass: 'S1',
    retrievedAt: new Date().toISOString(),
  };
}

/** openFDA phrase queries break on embedded quotes and backslashes. */
function escapeLucene(value) {
  return value.replace(/["\\]/g, '\\$&');
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A proxy error page or gateway timeout is HTML, not JSON. Surface the
      // status rather than a confusing JSON.parse error.
      if (!res.ok) {
        throw new Error(
          `openFDA returned HTTP ${res.status} with a non-JSON body (${text.slice(0, 120)})`,
        );
      }
      throw new Error('openFDA returned a non-JSON body');
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`openFDA request timed out after ${HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
