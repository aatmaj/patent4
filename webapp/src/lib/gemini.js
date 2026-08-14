import { MODEL, THINKING_RESERVE_TOKENS, LLM_MAX_RETRIES } from './config.js';

/**
 * Gemini transport, exposed behind the Anthropic-shaped interface the agents
 * were written against (`createMessage` / `textOf` / `toolUseOf`).
 *
 * The call sites — the orchestrator loop, the FTO classifier, the SQL
 * generators — speak in content blocks: `tool_use`, `tool_result`, `text`.
 * Rewriting six of them to speak Gemini's `parts` dialect would have meant
 * re-testing the agentic loop, the harness's tool-output plumbing and the
 * JSON-repair path all at once. Translating at this one boundary instead keeps
 * that surface untouched, so a provider swap is a transport change and not a
 * rewrite of the reasoning code.
 *
 * Three behavioural differences are handled here rather than left to callers:
 *
 *  1. THINKING IS NOT OPTIONAL on Gemini 3 Pro (`thinkingBudget: 0` is
 *     rejected outright: "This model only works in thinking mode"), and
 *     reasoning tokens are billed against `maxOutputTokens` — unlike
 *     Anthropic's `max_tokens`, which bounds visible output only. Measured:
 *     a request with `maxOutputTokens: 512` spent 489 tokens thinking and got
 *     19 of answer out before `finishReason: MAX_TOKENS` truncated it. Every
 *     ceiling in this codebase was sized under Anthropic's meaning (physchem
 *     asks for 512), so the reserve below is added on top rather than the
 *     numbers being reinterpreted at each call site.
 *
 *  2. THOUGHT SIGNATURES must survive the round trip. Gemini 3 returns an
 *     opaque `thoughtSignature` on the parts it emits, and expects it back
 *     verbatim on the next turn to carry reasoning across a tool call. It
 *     rides along on the mapped blocks as `_thoughtSignature` and is put back
 *     on the way out, so the orchestrator's `messages.push(response.content)`
 *     keeps working unchanged.
 *
 *  3. FREE-FORM OBJECT PARAMETERS survive only via `parametersJsonSchema`.
 *     Gemini's older `parameters` field takes an OpenAPI subset that drops any
 *     object without declared `properties`: the `arithmetic` tool came back as
 *     `{operation: 'in_range', params: {}}` — every argument silently gone,
 *     which the harness would then have failed as an unbacked numeric verdict.
 *     `parametersJsonSchema` takes the JSON Schema in `input_schema` as-is and
 *     returns the arguments intact.
 */

const API_BASE =
  process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';

/** Transient conditions worth a retry; anything else fails fast. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function apiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error(
      'Missing GEMINI_API_KEY. Add it to webapp/.env.local (see README).',
    );
  }
  return key;
}

/**
 * Anthropic-shaped `messages.create`.
 *
 * @param {object}       args
 * @param {string|Array} [args.system]       String or Anthropic system blocks.
 * @param {Array}        args.messages       Anthropic-shaped messages.
 * @param {number}       args.max_tokens     Ceiling on VISIBLE output.
 * @param {Array}        [args.tools]        Tools with `input_schema`.
 * @param {object}       [args.tool_choice]  {type:'tool',name} | {type:'any'|'auto'}
 * @returns {Promise<object>} Anthropic-shaped response: `content` blocks,
 *   `stop_reason`, `usage`.
 */
export async function createMessage({
  system,
  cacheSystem, // Anthropic-only; Gemini caches repeated prefixes implicitly.
  model = MODEL,
  max_tokens,
  messages = [],
  tools,
  tool_choice,
  temperature,
  top_p,
  stop_sequences,
  ...rest
}) {
  void cacheSystem;

  const generationConfig = {
    // Reserve room for reasoning on top of the caller's visible-output budget.
    maxOutputTokens: (max_tokens || 4096) + THINKING_RESERVE_TOKENS,
    ...(temperature != null ? { temperature } : {}),
    ...(top_p != null ? { topP: top_p } : {}),
    ...(stop_sequences ? { stopSequences: stop_sequences } : {}),
  };

  const body = {
    contents: toContents(messages),
    generationConfig,
    ...(systemInstruction(system) ? { systemInstruction: systemInstruction(system) } : {}),
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map(toDeclaration) }] } : {}),
    ...(toolConfig(tool_choice) ? { toolConfig: toolConfig(tool_choice) } : {}),
    ...rest,
  };

  const json = await post(model, body);
  return toAnthropicResponse(json, model);
}

/** POST with bounded retry on rate limits and 5xx. */
async function post(model, body) {
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  let lastError;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure. Carry a 503 so the orchestrator classifies it as
      // infrastructure rather than as a tool-logic error.
      lastError = Object.assign(new Error(`Gemini request failed: ${err.message}`), {
        status: 503,
      });
      if (attempt < LLM_MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    if (response.ok) return response.json();

    const detail = await response.text().catch(() => '');
    const err = Object.assign(
      new Error(`Gemini API ${response.status}: ${message(detail) || response.statusText}`),
      { status: response.status },
    );

    if (!RETRYABLE.has(response.status) || attempt === LLM_MAX_RETRIES) throw err;
    lastError = err;
    await sleep(retryAfterMs(response) ?? backoffMs(attempt));
  }

  throw lastError;
}

function message(detail) {
  try {
    return JSON.parse(detail)?.error?.message || detail.slice(0, 300);
  } catch {
    return detail.slice(0, 300);
  }
}

function retryAfterMs(response) {
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : null;
}

const backoffMs = (attempt) => 500 * 2 ** attempt + Math.random() * 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── request translation ───────────────────────── */

/** Anthropic `system` (string or text blocks) -> Gemini systemInstruction. */
function systemInstruction(system) {
  if (!system) return null;
  const text =
    typeof system === 'string'
      ? system
      : system
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n');
  return text ? { parts: [{ text }] } : null;
}

/**
 * Anthropic messages -> Gemini contents.
 *
 * A tool_result block only carries `tool_use_id`, but Gemini's
 * functionResponse is keyed by function NAME, so the id is resolved against
 * the tool_use blocks earlier in the same conversation.
 */
function toContents(messages) {
  const nameById = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') nameById.set(block.id, block.name);
    }
  }

  const contents = [];
  for (const m of messages) {
    const parts = toParts(m.content, nameById);
    if (parts.length === 0) continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

function toParts(content, nameById) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const block of content) {
    const signed = (part) =>
      block._thoughtSignature ? { ...part, thoughtSignature: block._thoughtSignature } : part;

    if (block.type === 'text') {
      if (block.text) parts.push(signed({ text: block.text }));
    } else if (block.type === 'tool_use') {
      parts.push(
        signed({
          functionCall: {
            ...(block.id ? { id: block.id } : {}),
            name: block.name,
            args: block.input || {},
          },
        }),
      );
    } else if (block.type === 'tool_result') {
      parts.push({
        functionResponse: {
          ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
          name: nameById.get(block.tool_use_id) || 'tool',
          response: toResponsePayload(block),
        },
      });
    }
  }
  return parts;
}

/**
 * Gemini requires functionResponse.response to be a JSON object. The
 * orchestrator hands us a JSON string, so it is parsed back where possible and
 * wrapped otherwise — the model sees the same structure it saw on Anthropic.
 */
function toResponsePayload(block) {
  const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  const isPlainObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const payload = isPlainObject ? { ...parsed } : { result: parsed };

  // Gemini has no is_error flag on functionResponse; make the failure explicit
  // in the payload so the model does not read an error as a normal result.
  if (block.is_error && payload.error === undefined) payload.error = true;
  return payload;
}

/**
 * Anthropic tool -> Gemini functionDeclaration.
 *
 * `input_schema` is passed through as `parametersJsonSchema`, not `parameters`:
 * see note 3 in the header — the OpenAPI-subset field silently discards
 * free-form object arguments.
 */
function toDeclaration(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema || { type: 'object', properties: {} },
  };
}

function toolConfig(toolChoice) {
  if (!toolChoice) return null;
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] },
    };
  }
  if (toolChoice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  return null; // 'auto' is Gemini's default
}

/* ───────────────────────── response translation ───────────────────────── */

const STOP_REASONS = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  BLOCKLIST: 'refusal',
};

function toAnthropicResponse(json, model) {
  const candidate = json?.candidates?.[0];

  // A prompt rejected before generation returns no candidate at all.
  if (!candidate) {
    const blockReason = json?.promptFeedback?.blockReason;
    if (blockReason) {
      throw Object.assign(new Error(`Gemini blocked the prompt: ${blockReason}`), {
        status: 400,
      });
    }
    throw Object.assign(new Error('Gemini returned no candidates.'), { status: 502 });
  }

  const content = [];
  for (const part of candidate.content?.parts || []) {
    // Thought summaries are internal narration, not answer text.
    if (part.thought) continue;

    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: part.functionCall.id || `call_${Math.random().toString(36).slice(2, 12)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
        ...(part.thoughtSignature ? { _thoughtSignature: part.thoughtSignature } : {}),
      });
    } else if (typeof part.text === 'string' && part.text.length > 0) {
      content.push({
        type: 'text',
        text: part.text,
        ...(part.thoughtSignature ? { _thoughtSignature: part.thoughtSignature } : {}),
      });
    }
  }

  const usage = json.usageMetadata || {};
  const hasToolUse = content.some((b) => b.type === 'tool_use');
  const finish = candidate.finishReason;

  return {
    id: json.responseId,
    type: 'message',
    role: 'assistant',
    model: json.modelVersion || model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : STOP_REASONS[finish] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
      thinking_tokens: usage.thoughtsTokenCount || 0,
      // Gemini's implicit prefix cache is the analogue of Anthropic's ephemeral
      // cache reads; there is no separate write to report.
      cache_read_input_tokens: usage.cachedContentTokenCount || 0,
      cache_creation_input_tokens: 0,
    },
    _finishReason: finish,
  };
}

/* ───────────────────────── accessors ───────────────────────── */

/** First text block of a response, or ''. */
export function textOf(response) {
  return response?.content?.find((c) => c.type === 'text')?.text || '';
}

/** First tool_use block of a response, or undefined. */
export function toolUseOf(response) {
  return response?.content?.find((c) => c.type === 'tool_use');
}
