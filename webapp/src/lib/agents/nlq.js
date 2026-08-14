import semanticModelJson from '../semanticModel.json' with { type: 'json' };
import { runQuery, dryRunBytes } from '../bigquery.js';
import { createMessage, textOf } from '../gemini.js';
import { BQ_MAX_BYTES_BILLED, UTILITY_MODEL } from '../config.js';
import { assertReadOnlySelect } from './patentFto.js';

/**
 * Natural-language query agent: question -> BigQuery SQL -> rows.
 *
 * The generated SQL is model output, so it goes through the same structural
 * guard and cost ceiling as the FTO search before it executes.
 */

/**
 * The semantic model is imported rather than read from disk.
 *
 * It used to be `readFileSync(join(process.cwd(), 'src/lib/semanticModel.json'))`,
 * which works from a repo checkout and fails everywhere else: a container built
 * from Next's standalone output has no `src/` directory, and cwd is the app
 * root, so the read threw at runtime and took NLQ and the orchestrator's
 * structured_query tool down with it. An import is traced into the build, so it
 * ships with the bundle wherever that bundle runs.
 */
const SEMANTIC_MODEL = JSON.stringify(semanticModelJson, null, 2);

export async function nlq({ question }) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    const err = new Error('Question is required');
    err.status = 400;
    throw err;
  }

  const prompt = `You are a BigQuery SQL Expert for a pharmaceutical R&D team.
Translate the following natural language question into a valid Google BigQuery Standard SQL query.

Here is the Semantic Model of the datasets available to you:
${SEMANTIC_MODEL}

CRITICAL INSTRUCTIONS:
1. Output ONLY the raw SQL query. Do not include markdown blocks like \`\`\`sql.
2. Do not include any explanations or prose. Your output will be executed directly as SQL.
3. Use fully qualified table names (e.g., bigquery-public-data.fda_drug.drug_product).
4. Limit results to 100 max.
5. STRICT TABLE RULE: You may ONLY use the tables explicitly defined in the Semantic Model. Do not invent table names.
6. Emit a single read-only SELECT statement. No DDL, DML, scripting, or multiple statements.

Question: ${question}`;

  const response = await createMessage({
    model: UTILITY_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const sql = textOf(response)
    .trim()
    .replace(/```sql/gi, '')
    .replace(/```/g, '')
    .trim();

  assertReadOnlySelect(sql);

  let estimatedBytes = null;
  try {
    estimatedBytes = await dryRunBytes(sql);
    if (estimatedBytes > BQ_MAX_BYTES_BILLED) {
      throw new Error(
        `Generated SQL would scan ${(estimatedBytes / 1024 ** 3).toFixed(1)} GiB, ` +
          `over the ${(BQ_MAX_BYTES_BILLED / 1024 ** 3).toFixed(1)} GiB ceiling. Query refused.`,
      );
    }
  } catch (err) {
    if (/ceiling/.test(err.message)) throw err;
  }

  const rows = await runQuery(sql);

  return {
    sql,
    rows,
    estimatedBytesScanned: estimatedBytes,
    rowCount: rows.length,
    provenance: {
      dataset: 'semanticModel',
      refreshDate: new Date().toISOString(),
      evidenceClass: 'S1',
    },
  };
}
