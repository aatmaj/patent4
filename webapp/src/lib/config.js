/**
 * Central configuration. Model IDs, project IDs and cost/time limits were
 * previously duplicated across six route files; change them here only.
 */

// Gemini model used by every agent. Override with GEMINI_MODEL.
// gemini-3.1-pro-preview is the reasoning tier; gemini-3.7-flash is the cheaper
// swap and passes the same tool-calling round trip.
export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

// Headroom added to every `max_tokens` before it is sent as Gemini's
// `maxOutputTokens`.
//
// The two ceilings do not mean the same thing. Anthropic's bounds visible
// output; Gemini's bounds reasoning + visible output, and reasoning cannot be
// switched off on the Pro models — `thinkingBudget: 0` is rejected with "This
// model only works in thinking mode". Passing the existing numbers through
// unchanged truncated the answers: at maxOutputTokens 512 a physchem call
// burned 489 tokens thinking and returned 19 tokens of a JSON object before
// hitting MAX_TOKENS.
//
// Sized to cover observed reasoning (400-1500 tokens on these prompts) with
// room for the orchestrator's longer deliberation, and still leave the largest
// request — ORCHESTRATOR_MAX_TOKENS + this — inside the 65536 output limit.
export const THINKING_RESERVE_TOKENS = Number(
  process.env.THINKING_RESERVE_TOKENS || 8192,
);

// Retries for 429/5xx from the model API, on top of the first attempt.
export const LLM_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 2);

/**
 * Model for the FTO batch classifier. Defaults to MODEL, so the shipped
 * behaviour is unchanged.
 *
 * This exists because classification is the one model call that is mechanical
 * enough to consider downgrading, and the tradeoff is measurable rather than a
 * matter of taste. Over 100 real patents, 13 batches:
 *
 *   gemini-3.1-pro-preview .... 18.6-30.0 s
 *   gemini-3.7-flash ..........  8.8-10.2 s
 *
 * Agreement on the layer set assigned to each patent:
 *
 *   Pro vs Pro, run to run .... 95%   <- the noise floor
 *   Pro vs Flash .............. 86-92%
 *
 * So Flash is roughly twice as fast but diverges more than Pro diverges from
 * itself: it is a real quality change, not free. Left opt-in for that reason —
 * set GEMINI_CLASSIFIER_MODEL=gemini-3.7-flash to take the trade.
 */
export const CLASSIFIER_MODEL = process.env.GEMINI_CLASSIFIER_MODEL || MODEL;

/**
 * Model for the mechanical sub-agent calls: NL->SQL generation and the physchem
 * annotation. Both default to MODEL.
 *
 * These are the two calls with the least judgement in them — one translates a
 * question into SQL that is then structurally validated, cost-gated and
 * dry-run before it can execute, and the other summarises properties that were
 * already retrieved. Their output is checked by machinery downstream either
 * way, which is what makes them the safest tier to downgrade.
 */
export const UTILITY_MODEL = process.env.GEMINI_UTILITY_MODEL || MODEL;

// Google Cloud project that owns the BigQuery jobs (i.e. who gets billed).
export const GCP_PROJECT_ID =
  process.env.GCP_PROJECT_ID || 'gen-lang-client-0471305973';

// Hard ceiling on bytes billed per BigQuery job. The FTO and NLQ agents run
// model-generated SQL against patents-public-data, which is large enough that
// one unconstrained join is a real bill. BigQuery fails the job rather than
// running it when the estimate exceeds this.
// Measured: the minimal title-sweep column set scans ~18.9 GiB, so 25 GiB
// leaves headroom for query variation without admitting an abstract or claims
// column (those are 200+ GiB — see patentText.js).
export const BQ_MAX_BYTES_BILLED = Number(
  process.env.BQ_MAX_BYTES_BILLED || 25 * 1024 ** 3, // 25 GiB
);

// Wall-clock ceiling for a single BigQuery job.
export const BQ_TIMEOUT_MS = Number(process.env.BQ_TIMEOUT_MS || 60_000);

// Wall-clock ceiling for outbound HTTP (openFDA).
export const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 20_000);

// Orchestrator agentic-loop ceiling. The system prompt targets 4 turns and
// budgets 7; this is the hard stop that also absorbs JSON-repair retries.
export const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS || 8);

// Per-call output ceiling for the orchestrator. Large because the envelope is
// a sizable JSON document.
export const ORCHESTRATOR_MAX_TOKENS = 16000;

/** Today as YYYY-MM-DD, evaluated per call so a long-lived process stays correct. */
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Today as YYYYMMDD, matching openFDA / BigQuery patent date encoding. */
export function todayCompact() {
  return todayISO().replace(/-/g, '');
}
