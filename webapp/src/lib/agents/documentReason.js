import { fetchPatentText } from '../patentText.js';
import { createMessage, textOf } from '../gemini.js';
import { MODEL } from '../config.js';

/**
 * document_reason agent — schema-constrained extraction from primary text.
 *
 * Evidence class is decided by *provenance*, not by output shape:
 *   U1  every document's text was retrieved from primary full text this call
 *   U2  any document's text was supplied by the caller (i.e. possibly recalled)
 *
 * The set of IDs actually retrieved is returned in `retrievedFromBigQuery` so
 * the orchestrator harness can verify a corridor's U1 claim against real
 * provenance rather than trusting the model's self-report. (The field keeps its
 * name for compatibility with the harness; the source is now per-document full
 * text over HTTP rather than a BigQuery column scan.)
 */
const SYSTEM_PROMPT = `You are a precision regulatory reasoning agent. Your sole purpose is to read the provided source documents and answer the user's question by extracting the information into the exact JSON schema requested.
Do not hallucinate. If the information is not present, emit null or empty arrays as appropriate for the schema.
Only emit the raw JSON object. Do not wrap in markdown blocks.

CRITICAL RULE: If the input document contains no numeric limitation or specific chemical formulation details, your output MUST NOT contain them. Do not infer, guess, or inject recalled knowledge. If the exact numbers are not in the provided text, output null or empty strings.`;

export async function documentReason({ documents, question, extractionSchema }) {
  if (!extractionSchema || Object.keys(extractionSchema).length === 0) {
    const err = new Error(
      'extractionSchema is required. Free-form summarization is prohibited.',
    );
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    const err = new Error('At least one document is required.');
    err.status = 400;
    throw err;
  }
  if (documents.length > 10) {
    const err = new Error('At most 10 documents per call.');
    err.status = 400;
    throw err;
  }

  const prepared = [];
  const retrievedPrimary = [];
  const retrievalFailures = [];

  for (const doc of documents) {
    const id = doc?.id ? String(doc.id) : null;
    const supplied = typeof doc?.text === 'string' ? doc.text : '';

    // Retrieve when the caller asked for it, or when they passed an empty
    // text with an id (the documented "let the agent fetch it" protocol).
    // Previously this also fired on any text under 500 characters, which
    // silently discarded a short but legitimate caller-supplied claim.
    const wantsRetrieval =
      id && (doc.fetchFromBigQuery === true || doc.fetchText === true || supplied.trim() === '');

    if (!wantsRetrieval) {
      prepared.push({ id, text: supplied, source: 'caller-supplied' });
      continue;
    }

    // Retrieved per document over HTTP rather than from BigQuery: that table
    // is unpartitioned and unclustered, so pulling claims for a single
    // publication scans the whole claims_localized column (measured 116.6 GiB
    // per patent, which is what exhausted the cost ceiling and blocked claim
    // retrieval entirely).
    const fetched = await fetchPatentText(id);
    if (fetched.ok && fetched.claimsText) {
      prepared.push({
        id,
        text: fetched.claimsText,
        source: `Google Patents full text (${fetched.claimCount} claims, ${fetched.source})`,
        retrieved: true,
      });
      retrievedPrimary.push(id);
    } else {
      retrievalFailures.push({
        id,
        reason: fetched.error || 'no claim text returned',
        source: fetched.source,
      });
      prepared.push({
        id,
        text: supplied,
        source: supplied
          ? 'caller-supplied (retrieval failed)'
          : 'none (retrieval failed, nothing supplied)',
        retrieved: false,
      });
    }
  }

  const usable = prepared.filter((d) => d.text && d.text.trim().length > 0);
  if (usable.length === 0) {
    return {
      extracted: {},
      evidenceClass: 'U2',
      question,
      documentsAnalyzed: prepared.map((d) => d.id || 'unknown'),
      retrievedFromBigQuery: retrievedPrimary,
      retrievalFailures,
      status: 'NO_TEXT',
      note:
        'No document text was available: full-text retrieval failed and no text was supplied. ' +
        'Nothing was extracted. Treat the evidence ceiling for these patents as U2, and do not ' +
        'assert claim boundaries for them.',
    };
  }

  const docText = prepared
    .map((d, i) => `--- Document ${i + 1}: ${d.id || 'unknown'} (${d.source}) ---\n${d.text}`)
    .join('\n\n');

  const userPrompt = `Question: ${question}

Extraction Schema (return JSON matching this structure exactly):
${JSON.stringify(extractionSchema, null, 2)}

Documents to analyze:
${docText}

Return ONLY the JSON object matching the extraction schema. Include a "citations" field mapping each extracted value to its document source location.`;

  const response = await createMessage({
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const responseText = textOf(response);
  let parsed;
  let parseError = false;
  try {
    const match = responseText.trim().match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { raw: responseText };
  } catch {
    parsed = { raw: responseText };
    parseError = true;
  }

  const { value: extracted, stripped } = stripUngrounded(parsed, docText);

  // U1 requires that *every* document was retrieved. One caller-supplied
  // document contaminates the whole extraction.
  const allRetrieved =
    prepared.length > 0 && retrievedPrimary.length === prepared.length;

  return {
    extracted,
    strippedPaths: stripped,
    evidenceClass: allRetrieved ? 'U1' : 'U2',
    evidenceClassReason: allRetrieved
      ? 'All document text retrieved from primary full text this session.'
      : 'At least one document used caller-supplied text; provenance cannot be confirmed as primary.',
    question,
    documentsAnalyzed: prepared.map((d) => d.id || 'unknown'),
    documentSources: prepared.map((d) => ({ id: d.id, source: d.source })),
    retrievedFromBigQuery: retrievedPrimary,
    retrievalFailures,
    parseError,
    model: MODEL,
    extractedAt: new Date().toISOString(),
    note: 'Extraction is schema-constrained and checked against source text; ungrounded values are nulled, not deleted.',
  };
}

/**
 * Null out values that do not appear in the source text.
 *
 * Two deliberate differences from a naive filter:
 *  - values are set to null rather than deleted, so schema-required keys
 *    survive and the caller can distinguish "absent from source" from
 *    "never extracted";
 *  - every nulled location is reported in `strippedPaths` so the removal is
 *    auditable instead of silent.
 *
 * The grounding check requires each numeric token to appear in the source with
 * a digit boundary, so "5" no longer matches any document containing "0.55".
 */
export function stripUngrounded(obj, sourceText, basePath = '$') {
  const stripped = [];

  function walk(node, path) {
    if (Array.isArray(node)) {
      return node.map((v, i) => walk(v, `${path}[${i}]`));
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, `${path}.${k}`);
      }
      return out;
    }
    if (typeof node === 'string') {
      const numbers = node.match(/\d+(?:\.\d+)?/g);
      if (numbers && !numbers.every((n) => hasNumberToken(sourceText, n))) {
        stripped.push({ path, reason: 'numeric value not found in source text' });
        return null;
      }
      return node;
    }
    if (typeof node === 'number') {
      if (!hasNumberToken(sourceText, String(node))) {
        stripped.push({ path, reason: 'numeric value not found in source text' });
        return null;
      }
      return node;
    }
    return node;
  }

  const value = walk(obj, basePath);
  return { value, stripped };
}

/** True when `token` appears in `text` bounded by non-digit characters. */
function hasNumberToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(text);
}
