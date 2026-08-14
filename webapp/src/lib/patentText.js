import { HTTP_TIMEOUT_MS } from './config.js';

/**
 * Per-document patent full text (abstract + claims), fetched by publication
 * number from Google Patents.
 *
 * Why not BigQuery: `patents-public-data.patents.publications` has no
 * partitioning and no clustering (measured: 2.81 TiB over 170M rows, both
 * `timePartitioning` and `clustering` null). A WHERE clause therefore prunes
 * nothing — BigQuery reads every byte of each referenced column. Measured
 * dry-run costs:
 *
 *   claims_localized for ONE publication ......... 116.6 GiB
 *   title + abstract sweep ....................... 222.5 GiB
 *   same sweep + a grant_date range .............. 218.6 GiB  (no pruning)
 *   title only, no abstract ......................  17.6 GiB
 *
 * So retrieving claim text from BigQuery costs ~117 GiB per patent regardless
 * of how narrow the filter is. One HTTP GET costs nothing and returns the same
 * text. BigQuery keeps the broad landscape sweep (where scanning is the point);
 * this module handles document retrieval.
 *
 * This is HTML scraping, not a supported API: it is best-effort by design, and
 * every failure is reported to the caller rather than silently swallowed, so a
 * missing document downgrades the evidence class instead of inviting recall.
 */

const BASE = 'https://patents.google.com/patent';
const USER_AGENT =
  process.env.PATENT_TEXT_USER_AGENT ||
  'FormuGraph/1.0 (research tool; contact: set PATENT_TEXT_USER_AGENT)';

/**
 * Concurrency cap for the per-document fetches.
 *
 * This is the single largest avoidable delay in an FTO run: the agent fetches
 * up to 60 abstracts, and at the original cap of 4 that serialised into 15
 * rounds. Measured against a real 60-publication set, cold cache each time:
 *
 *    4 ....  9.4 s    60/60 ok
 *    8 ....  4.3 s    60/60 ok
 *   12 ....  2.7 s    60/60 ok
 *   16 ....  2.7 s    60/60 ok
 *   24 ....  2.0 s    60/60 ok
 *
 * Nothing was dropped at any level, so the speedup costs no recall — every
 * abstract that reached the classifier before still reaches it. 12 is the knee
 * of the curve; past it the gain is small and the odds of Google Patents
 * throttling a sustained crawl rise, which WOULD cost recall.
 */
const MAX_CONCURRENT = Number(process.env.PATENT_TEXT_CONCURRENCY || 12);

// Process-lifetime cache. Claim text for a granted patent does not change.
const cache = new Map();

/**
 * Normalise a publication number to the Google Patents document id.
 * "US-11318191-B2" / "US 11318191 B2" / "11318191" -> "US11318191B2".
 * A bare number is assumed to be a US grant, which is stated in the result so
 * the caller can see the assumption rather than inherit it silently.
 */
export function toDocumentId(publicationNumber) {
  const raw = String(publicationNumber || '').trim().toUpperCase();
  if (!raw) return null;

  const compact = raw.replace(/[\s\-_/]/g, '');
  if (/^[A-Z]{2}\d+[A-Z]\d?$/.test(compact)) return compact;
  if (/^[A-Z]{2}\d+$/.test(compact)) return compact;
  if (/^\d{6,}$/.test(compact)) return `US${compact}`;
  return compact || null;
}

/**
 * Fetch one patent's text.
 * @returns {Promise<{ok: boolean, id, documentId, title, abstract, claims, claimCount, grantDate, source, error?}>}
 */
export async function fetchPatentText(publicationNumber, { signal } = {}) {
  const documentId = toDocumentId(publicationNumber);
  if (!documentId) {
    return {
      ok: false,
      id: publicationNumber,
      documentId: null,
      error: 'could not derive a document id from the publication number',
    };
  }

  if (cache.has(documentId)) return cache.get(documentId);

  const url = `${BASE}/${documentId}/en`;
  let result;

  try {
    const html = await get(url, signal);
    const claims = extractClaims(html);
    const abstract = extractAbstract(html);

    if (claims.length === 0 && !abstract) {
      result = {
        ok: false,
        id: publicationNumber,
        documentId,
        error: 'document fetched but contained no claims or abstract (unknown or withdrawn publication)',
        source: url,
      };
    } else {
      result = {
        ok: true,
        id: publicationNumber,
        documentId,
        title: extractMeta(html, 'DC.title') || extractTitle(html),
        abstract,
        claims,
        claimCount: claims.length,
        claimsText: claims.map((c, i) => `${i + 1}. ${c}`).join('\n\n'),
        grantDate: extractMeta(html, 'DC.date') || null,
        assumedJurisdiction: /^\d/.test(String(publicationNumber).trim())
          ? 'US (assumed: bare number supplied)'
          : null,
        source: url,
        retrievedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    result = {
      ok: false,
      id: publicationNumber,
      documentId,
      error: err.message,
      source: url,
    };
  }

  // Cache failures too, briefly, so a batch does not retry the same 404 twenty
  // times; but do not cache transient network errors.
  if (result.ok || /no claims|not found|HTTP 4/.test(result.error || '')) {
    cache.set(documentId, result);
  }
  return result;
}

/** Fetch many, with bounded concurrency. Never rejects; failures are in-band. */
export async function fetchPatentTexts(publicationNumbers, opts = {}) {
  const ids = [...new Set((publicationNumbers || []).filter(Boolean))];
  const results = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, ids.length) }, async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      results[i] = await fetchPatentText(ids[i], opts);
    }
  });

  await Promise.all(workers);
  return results;
}

async function get(url, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
    if (res.status === 404) throw new Error('HTTP 404 — publication not found');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`request timed out after ${HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

/* ── HTML extraction ────────────────────────────────────────────────────── */

export function extractClaims(html) {
  const blocks = [...html.matchAll(/<div[^>]*class="claim-text"[^>]*>([\s\S]*?)<\/div>/g)];
  return blocks
    .map((m) => stripTags(m[1]))
    .filter(Boolean)
    // Google Patents renders sub-clauses as their own claim-text divs; join
    // fragments that are clearly continuations of a numbered claim.
    .reduce((acc, text) => {
      if (/^\d+\s*\./.test(text) || acc.length === 0) acc.push(text);
      else acc[acc.length - 1] += ` ${text}`;
      return acc;
    }, [])
    .map((t) => t.replace(/^\d+\s*\.\s*/, '').trim())
    .filter((t) => t.length > 0);
}

export function extractAbstract(html) {
  const div = html.match(/<div[^>]*class="abstract"[^>]*>([\s\S]*?)<\/div>/);
  if (div) return stripTags(div[1]);
  const meta = extractMeta(html, 'description');
  return meta ? meta.trim() : null;
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? stripTags(m[1]).replace(/\s*-\s*Google Patents\s*$/, '') : null;
}

function extractMeta(html, name) {
  const m = html.match(
    new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`, 'i'),
  );
  return m ? decodeEntities(m[1]) : null;
}

function stripTags(fragment) {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Test helper. */
export function __clearCache() {
  cache.clear();
}
