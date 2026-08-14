import { BigQuery } from '@google-cloud/bigquery';
import path from 'path';
import fs from 'fs';
import { GCP_PROJECT_ID, BQ_MAX_BYTES_BILLED, BQ_TIMEOUT_MS } from './config.js';

/**
 * Single shared BigQuery client.
 *
 * Credential resolution, in order:
 *   1. GCP_CREDENTIALS_JSON  — the service-account JSON inline (base64 or raw).
 *      This is the only option that works on serverless/containers, where
 *      there is no repo checkout to read a key file from.
 *   2. GOOGLE_APPLICATION_CREDENTIALS — standard ADC path, also picked up
 *      automatically by the client library.
 *   3. ../credentials.json relative to the Next.js cwd — the original
 *      behaviour, kept so local development keeps working unchanged.
 *
 * Never commit the key file. See the repo-root .gitignore.
 */
let client;

function resolveCredentials() {
  const inline = process.env.GCP_CREDENTIALS_JSON;
  if (inline) {
    const text = inline.trim().startsWith('{')
      ? inline
      : Buffer.from(inline, 'base64').toString('utf8');
    return { credentials: JSON.parse(text) };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Let the client library pick it up from the environment.
    return {};
  }

  const legacyPath = path.join(process.cwd(), '../credentials.json');
  if (fs.existsSync(legacyPath)) {
    return { keyFilename: legacyPath };
  }

  // Application Default Credentials. On Cloud Run, GKE or a GCE VM this is the
  // attached service account, fetched from the metadata server — the best of
  // these options, because no key material exists to leak or rotate. It used to
  // throw here instead, which made the app unable to start anywhere that had
  // ADC and no key file. If ADC is genuinely absent the client library raises
  // its own error on first use, naming the missing credential.
  return {};
}

export function getBigQuery() {
  if (!client) {
    client = new BigQuery({ projectId: GCP_PROJECT_ID, ...resolveCredentials() });
  }
  return client;
}

/**
 * Run a query with a hard cost ceiling and timeout.
 *
 * Always prefer `params` over string interpolation: several of these queries
 * are built from values that originate in an LLM tool call, which in turn
 * originates in user input.
 *
 * @param {string} query        Standard SQL.
 * @param {object} [params]     Named parameters referenced as @name in the SQL.
 * @param {object} [opts]
 * @param {number} [opts.maximumBytesBilled]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Array<object>>} rows
 */
export async function runQuery(query, params, opts = {}) {
  const bigquery = getBigQuery();
  const job = {
    query,
    // BigQuery rejects the job outright if the dry-run estimate exceeds this,
    // so a runaway generated query costs nothing instead of a lot.
    maximumBytesBilled: String(opts.maximumBytesBilled ?? BQ_MAX_BYTES_BILLED),
    jobTimeoutMs: String(opts.timeoutMs ?? BQ_TIMEOUT_MS),
  };
  if (params && Object.keys(params).length > 0) job.params = params;

  const [queryJob] = await bigquery.createQueryJob(job);
  const [rows] = await queryJob.getQueryResults({
    timeoutMs: opts.timeoutMs ?? BQ_TIMEOUT_MS,
  });
  return rows;
}

/**
 * Estimate the bytes a query would process without running it.
 * Used to reject expensive model-generated SQL before it executes, with a
 * clearer error than BigQuery's own maximumBytesBilled failure.
 */
export async function dryRunBytes(query) {
  const bigquery = getBigQuery();
  const [job] = await bigquery.createQueryJob({ query, dryRun: true });
  return Number(job.metadata.statistics.totalBytesProcessed || 0);
}
