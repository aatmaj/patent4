import { runQuery, dryRunBytes } from '../bigquery.js';
import { fetchPatentTexts } from '../patentText.js';
import { createMessage, textOf, toolUseOf } from '../gemini.js';
import { BQ_MAX_BYTES_BILLED, CLASSIFIER_MODEL, UTILITY_MODEL } from '../config.js';
import { normalizePatentDate } from '../dates.js';

export const FTO_LAYERS = [
  'coreStructure',
  'polymorph',
  'formulation',
  'processSynthesis',
  'methodOfUse',
  'combination',
];

const BATCH_SIZE = 8; // small batches keep structured output reliable
const SEARCH_LIMIT = 100;

/**
 * Column budget for the landscape sweep.
 *
 * `patents-public-data.patents.publications` is 2.81 TiB over 170M rows with
 * NO partitioning and NO clustering (verified against table metadata), so a
 * WHERE clause prunes nothing — BigQuery reads every byte of each referenced
 * column. Measured dry runs:
 *
 *   title + abstract ............ 222.5 GiB   (blew the 20 GiB ceiling)
 *   + a grant_date range ........ 218.6 GiB   (a date filter does not help)
 *   title only, no abstract .....  17.6 GiB   (affordable)
 *
 * So the sweep searches titles only and the abstracts are fetched per document
 * over HTTP afterwards. That loses recall on patents naming the molecule only
 * in the abstract, which is attested rather than hidden — and the Orange Book
 * seed below recovers the set that matters most for a generic filing, since
 * those are the patents the innovator listed against the RLD.
 */
const ABSTRACT_IN_SWEEP = process.env.FTO_SWEEP_ABSTRACTS === 'true';

const patentEntry = {
  type: 'object',
  properties: {
    patentId: { type: 'string' },
    title: { type: 'string' },
    assignee: { type: 'string' },
    grantDate: { type: 'string' },
    country: { type: 'string' },
    rationale: { type: 'string' },
    riskLevel: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['patentId', 'riskLevel'],
};

const CLASSIFY_TOOL = {
  name: 'classify_patents',
  description:
    'Classify a batch of pharmaceutical patents into FTO taxonomy layers.',
  input_schema: {
    type: 'object',
    properties: {
      ...Object.fromEntries(
        FTO_LAYERS.map((l) => [l, { type: 'array', items: patentEntry }]),
      ),
      unclassified: {
        type: 'array',
        items: {
          type: 'object',
          properties: { patentId: { type: 'string' }, rationale: { type: 'string' } },
          required: ['patentId'],
        },
      },
    },
    required: [...FTO_LAYERS, 'unclassified'],
  },
};

/**
 * Patent FTO agent.
 * S1: search patents-public-data for publications mentioning the molecule.
 * U2: the model classifies each hit into the 6-layer FTO taxonomy from
 *     title + abstract only (claim text is a separate document_reason call).
 */
export async function patentFto({
  molecule,
  markets = ['US', 'EP', 'WO'],
  dosageForm,
  seedPatentNumbers = [],
}) {
  if (!molecule || typeof molecule !== 'string' || !molecule.trim()) {
    const err = new Error('molecule is required');
    err.status = 400;
    throw err;
  }

  const safeMarkets = sanitizeMarkets(markets);
  const sql = await generateSearchSql(molecule, safeMarkets);

  // Cost-gate the generated query before running it, then run it. Either step
  // may knock out the sweep; neither may take the Orange Book seeds down with
  // it. Those seeds are the patents actually listed against the RLD, and they
  // are precisely what an FTO assessment cannot proceed without — aborting the
  // whole agent because the landscape query was too expensive throws away the
  // most relevant evidence in the run.
  let rows = [];
  let sweepError = null;
  let estimatedBytes = null;

  try {
    try {
      estimatedBytes = await dryRunBytes(sql);
    } catch {
      // A dry-run failure is usually a syntax error in the generated SQL; let
      // the real execution surface it with BigQuery's own diagnostics.
    }
    if (estimatedBytes != null && estimatedBytes > BQ_MAX_BYTES_BILLED) {
      throw new Error(
        `Generated SQL would scan ${(estimatedBytes / 1024 ** 3).toFixed(1)} GiB, ` +
          `over the ${(BQ_MAX_BYTES_BILLED / 1024 ** 3).toFixed(1)} GiB ceiling. Query refused.`,
      );
    }
    rows = await runQuery(sql);
  } catch (err) {
    sweepError = err.message;
    if (seedPatentNumbers.length === 0) throw err;
    console.warn(
      `[patent-fto] landscape sweep unavailable (${err.message}); continuing with ` +
        `${seedPatentNumbers.length} Orange Book seed(s).`,
    );
  }

  // Seed with Orange Book patents. Title search misses them whenever the title
  // names a class ("GLP-1 receptor agonist") rather than the molecule, which is
  // the common case for formulation patents.
  const seeds = await enrichSeeds(seedPatentNumbers, rows);
  rows = mergeRows(rows, seeds);

  if (!rows || rows.length === 0) {
    return {
      layers: Object.fromEntries(FTO_LAYERS.map((l) => [l, []])),
      markets: { requested: safeMarkets, found: '' },
      hasParseError: false,
      generatedSql: sql,
      coverageAttestation: {
        jurisdictionsSearched: safeMarkets,
        datasetsSearched: ['patents-public-data.patents.publications'],
        asOfDate: new Date().toISOString(),
        patentsFound: 0,
        patentsClassified: 0,
        searchLimit: SEARCH_LIMIT,
        note: 'No granted patents found for this molecule in the specified markets. Absence of a hit is not evidence of freedom to operate.',
      },
      evidenceClass: 'U2',
      rawPatentCount: 0,
    };
  }

  // Abstracts are fetched per document over HTTP — they are the column that
  // made the sweep unaffordable, and classification needs them.
  const abstracts = await fetchAbstracts(rows);

  const patentSummaries = rows.map((r) => {
    const fetched = abstracts.get(String(r.publication_number));
    return {
      id: r.publication_number,
      title: r.title || fetched?.title || '',
      abstract: (r.abstract || fetched?.abstract || '').substring(0, 600),
      abstractSource: r.abstract ? 'bigquery' : fetched?.abstract ? 'full-text' : 'none',
      assignee: Array.isArray(r.assignee) ? r.assignee.join('; ') : r.assignee || '',
      filing_date: normalizePatentDate(r.filing_date),
      filing_date_raw: r.filing_date ?? null,
      grant_date: normalizePatentDate(r.grant_date) || fetched?.grantDate || null,
      country: r.country_code,
      origin: r._origin || 'sweep',
    };
  });

  const batches = [];
  for (let i = 0; i < patentSummaries.length; i += BATCH_SIZE) {
    batches.push({
      index: Math.floor(i / BATCH_SIZE) + 1,
      patents: patentSummaries.slice(i, i + BATCH_SIZE),
    });
  }

  const batchResults = await Promise.all(
    batches.map(({ index, patents }) =>
      classifyBatch({ index, total: batches.length, patents, molecule, dosageForm }),
    ),
  );

  const hasParseError = batchResults.some((b) => b.failed);
  const layers = Object.fromEntries(FTO_LAYERS.map((l) => [l, []]));
  const unclassified = [];
  const byId = new Map(patentSummaries.map((p) => [p.id, p]));

  for (const { parsed } of batchResults) {
    for (const layer of FTO_LAYERS) {
      for (const p of parsed[layer] || []) {
        const source = byId.get(p.patentId);
        layers[layer].push({
          ...p,
          // Carry the normalised S1 dates through so downstream expiry
          // arithmetic never sees a raw YYYYMMDD integer.
          filingDate: source?.filing_date ?? null,
          grantDate: p.grantDate ?? source?.grant_date ?? null,
          evidenceClass: 'U2',
          note: 'Classification based on title/abstract only; verify against claim text.',
        });
      }
    }
    for (const u of parsed.unclassified || []) unclassified.push(u);
  }

  const countriesFound = [...new Set(rows.map((r) => r.country_code))].join(', ');
  const classifiedCount = FTO_LAYERS.reduce((n, l) => n + layers[l].length, 0);
  const seedCount = rows.filter((r) => r._origin === 'orange-book-seed').length;

  const gaps = [];
  if (!ABSTRACT_IN_SWEEP) {
    gaps.push(
      'SEARCH SCOPE: the landscape sweep matched on patent TITLES only. Patents naming the ' +
        'molecule solely in the abstract or claims were not discovered by the sweep. Abstracts ' +
        'shown here were fetched per document after matching.',
    );
  }
  if (sweepError) {
    gaps.push(
      `LANDSCAPE SWEEP FAILED (${sweepError}). Only the ${seedCount} Orange Book seed patent(s) ` +
        'were classified. This is NOT a landscape search.',
    );
  }
  if (rows.length >= SEARCH_LIMIT) {
    gaps.push(
      `RESULT CAP: the search returned the maximum of ${SEARCH_LIMIT} results, so the landscape ` +
        'is truncated and additional patents almost certainly exist.',
    );
  }

  return {
    layers,
    unclassified,
    markets: { requested: safeMarkets, found: countriesFound },
    hasParseError,
    sweepError,
    attestation: `Search executed over patents-public-data for markets [${safeMarkets.join(',')}]. Returned ${rows.length} hits across countries: [${countriesFound || 'none'}]${seedCount ? `, including ${seedCount} seeded from the Orange Book` : ''}.`,
    generatedSql: sql,
    estimatedBytesScanned: estimatedBytes,
    coverageAttestation: {
      jurisdictionsSearched: safeMarkets,
      datasetsSearched: [
        'patents-public-data.patents.publications (title match)',
        'Google Patents full text (per-document abstract/claims)',
        ...(seedCount ? ['openFDA Orange Book (seed patents)'] : []),
      ],
      searchScope: ABSTRACT_IN_SWEEP ? 'title + abstract' : 'title only',
      asOfDate: new Date().toISOString(),
      patentsFound: rows.length,
      patentsFromSweep: rows.length - seedCount,
      patentsFromOrangeBookSeed: seedCount,
      patentsClassified: patentSummaries.length,
      distinctPatentsPlaced: classifiedCount,
      searchLimit: SEARCH_LIMIT,
      gaps,
      note:
        gaps.length > 0
          ? gaps.join(' ')
          : 'Classification is U2 (abstract-level). Full claim text review required for a legal FTO opinion.',
    },
    evidenceClass: 'U2',
    rawPatentCount: rows.length,
  };
}

/** Turn Orange Book patent numbers into rows the classifier can consume. */
async function enrichSeeds(seedPatentNumbers, existingRows) {
  const have = new Set(
    (existingRows || []).map((r) => normaliseId(r.publication_number)),
  );
  const wanted = [...new Set((seedPatentNumbers || []).map(String))].filter(
    (n) => n && !have.has(normaliseId(n)),
  );
  if (wanted.length === 0) return [];

  const fetched = await fetchPatentTexts(wanted.slice(0, 40));
  return fetched
    .filter((f) => f.ok)
    .map((f) => ({
      publication_number: f.documentId,
      title: f.title || '',
      abstract: f.abstract || '',
      filing_date: null,
      grant_date: f.grantDate ? f.grantDate.replace(/-/g, '') : null,
      assignee: '',
      country_code: f.documentId.slice(0, 2),
      _origin: 'orange-book-seed',
    }));
}

function mergeRows(rows, seeds) {
  const seen = new Set((rows || []).map((r) => normaliseId(r.publication_number)));
  const merged = [...(rows || [])];
  for (const s of seeds) {
    if (seen.has(normaliseId(s.publication_number))) continue;
    seen.add(normaliseId(s.publication_number));
    merged.push(s);
  }
  return merged;
}

/** Abstracts for rows that lack one, fetched per document. */
async function fetchAbstracts(rows) {
  const missing = rows
    .filter((r) => !r.abstract)
    .map((r) => String(r.publication_number))
    .slice(0, 60);
  const map = new Map();
  if (missing.length === 0) return map;

  const fetched = await fetchPatentTexts(missing);
  for (const f of fetched) {
    if (f.ok) map.set(f.id, { abstract: f.abstract, title: f.title, grantDate: f.grantDate });
  }
  return map;
}

function normaliseId(v) {
  return String(v || '').toUpperCase().replace(/[\s\-_/]/g, '');
}

/** Two-letter uppercase country codes only — these are interpolated into SQL. */
function sanitizeMarkets(markets) {
  const list = Array.isArray(markets) ? markets : [markets];
  const clean = list
    .filter((m) => typeof m === 'string')
    .map((m) => m.trim().toUpperCase())
    .filter((m) => /^[A-Z]{2}$/.test(m));
  if (clean.length === 0) {
    const err = new Error(
      'No valid market codes supplied. Expected two-letter codes such as US, EP, WO.',
    );
    err.status = 400;
    throw err;
  }
  return [...new Set(clean)];
}

/**
 * Generated sweep SQL, keyed on the inputs that determine it.
 *
 * BigQuery serves an identical query from its result cache for 24 hours at no
 * charge, but the sweep SQL is model-generated, so two runs of the same
 * molecule produced two different synonym lists, two different query strings
 * and two separate 18.9 GiB scans. Measured on one day: 71 sweep jobs, only 12
 * cache hits.
 *
 * Reusing the string for a given molecule/market pair makes the repeat run a
 * cache hit — free, and it also skips the SQL-generation model call. Evaluating
 * the same molecule repeatedly is the normal development loop, so this is where
 * the app's own BigQuery spend actually goes.
 *
 * Process-lifetime and unbounded on purpose: the key space is the molecules
 * examined in one server lifetime, and the value is a few hundred bytes.
 */
const sqlCache = new Map();

async function generateSearchSql(molecule, markets) {
  const cacheKey = `${String(molecule).trim().toLowerCase()}|${markets.join(',')}`;
  const cached = sqlCache.get(cacheKey);
  if (cached) return cached;

  const sql = await buildSearchSql(molecule, markets);
  sqlCache.set(cacheKey, sql);
  return sql;
}

/** Test helper. */
export function __clearSqlCache() {
  sqlCache.clear();
}

async function buildSearchSql(molecule, markets) {
  const marketFilter = markets.map((m) => `'${m}'`).join(', ');
  const prompt = `You are a BigQuery SQL expert and pharmaceutical patent searcher.
Generate a Google BigQuery SQL query to find up to ${SEARCH_LIMIT} patents for the drug "${molecule}".

Instead of just searching for the INN, inject your knowledge of the drug's synonyms, trade names, development codes, and protein targets/mechanisms of action into the query.
Search within the \`patents-public-data.patents.publications\` table.

CRITICAL INSTRUCTIONS:
1. Return ONLY the raw SQL query. No markdown formatting and no explanations.
2. The SELECT clause MUST EXACTLY BE:
   SELECT publication_number, title_localized[SAFE_OFFSET(0)].text AS title, grant_date, country_code
   Do NOT add columns. Each extra column is scanned across the whole 2.81 TiB table:
   adding assignee and application_number takes the same query from 18.9 GiB to 29.6 GiB
   and it is refused. Assignees, filing dates and abstracts are retrieved per document later.
3. Filter by country_code IN (${marketFilter}) and grant_date > 0.
4. Use LOWER() and LIKE (or REGEXP_CONTAINS) for keyword searches on title_localized[SAFE_OFFSET(0)].text ONLY.
   Do NOT reference abstract_localized or claims_localized anywhere in the query. Those columns are
   hundreds of GiB and the table is unpartitioned, so referencing them scans the whole column and the
   query will be refused. Abstracts are retrieved separately, per document.
   Because you can only match on the title, cast a WIDE net: include the INN, trade names, development
   codes, salt forms, and the drug class or mechanism (e.g. "GLP-1"), since formulation patents often
   name only the class in their title.
5. Order by grant_date DESC and LIMIT ${SEARCH_LIMIT}.
6. Emit a single SELECT statement. Do not emit DDL, DML, scripting, or multiple statements.`;

  const response = await createMessage({
    model: UTILITY_MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const sql = textOf(response)
    .trim()
    .replace(/```sql/gi, '')
    .replace(/```/g, '')
    .trim();

  assertReadOnlySelect(sql);
  return sql;
}

/**
 * Structural guard on model-generated SQL. The service account should also be
 * scoped read-only; this is the second layer, not the only one.
 */
export function assertReadOnlySelect(sql) {
  if (!sql) throw new Error('Model returned empty SQL.');

  const withoutStrings = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const forbidden =
    /\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|EXECUTE\s+IMMEDIATE|EXPORT\s+DATA|LOAD\s+DATA)\b/i;
  const match = withoutStrings.match(forbidden);
  if (match) {
    throw new Error(`Generated SQL contains a non-read statement (${match[1]}); refused.`);
  }

  if (!/^\s*(WITH|SELECT)\b/i.test(withoutStrings)) {
    throw new Error('Generated SQL must begin with SELECT or WITH; refused.');
  }

  // Reject stacked statements. A trailing semicolon is fine.
  const statements = withoutStrings
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length > 1) {
    throw new Error('Generated SQL contains multiple statements; refused.');
  }

  return true;
}

async function classifyBatch({ index, total, patents, molecule, dosageForm }) {
  const prompt = `Classify each patent into the 6-layer FTO taxonomy for ${molecule} (${dosageForm || 'unspecified'}).

Layers:
- coreStructure: active molecule (composition of matter)
- polymorph: crystal forms, salts, hydrates
- formulation: pharmaceutical composition, excipients, dosage form
- processSynthesis: manufacturing process, synthesis route
- methodOfUse: therapeutic indication, dosing regimen
- combination: combination with other actives
- unclassified: cannot determine from title/abstract

Patents (Batch ${index}/${total}):
${patents.map((p) => `[${p.id}] ${p.assignee || 'Unknown'} | ${p.title || 'No title'} | ${(p.abstract || '').slice(0, 300)}`).join('\n')}

Call classify_patents with ALL patents placed into their correct layers. A patent may appear in multiple layers.`;

  try {
    const response = await createMessage({
      model: CLASSIFIER_MODEL,
      max_tokens: 4000,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: CLASSIFY_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = toolUseOf(response);
    if (toolUse?.input) return { parsed: toolUse.input, failed: false };

    const repaired = repairJson(textOf(response));
    const match = repaired.match(/\{[\s\S]*\}/);
    if (match) return { parsed: JSON.parse(match[0]), failed: false };
    throw new Error('no structured output returned');
  } catch (err) {
    console.error(`[patent-fto] batch ${index} classification failed:`, err.message);
    return {
      failed: true,
      parsed: {
        unclassified: patents.map((p) => ({
          patentId: p.id,
          rationale: `Classification failed (${err.message}); manual review required.`,
        })),
      },
    };
  }
}

/**
 * Best-effort repair of truncated or fence-wrapped JSON. Only reached if
 * tool_use returned nothing, which the forced tool_choice makes rare.
 */
export function repairJson(str) {
  let out = str
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
    .replace(/,\s*([\]}])/g, '$1');

  // Close unbalanced brackets in the correct order by tracking the open stack,
  // rather than re-scanning the string as it mutates.
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of out) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) out += '"';
  while (stack.length) {
    out += stack.pop() === '{' ? '}' : ']';
  }
  return out;
}
