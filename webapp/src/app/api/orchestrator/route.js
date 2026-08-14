import { NextResponse } from 'next/server';
import { createMessage, textOf } from '@/lib/gemini';
import { guard } from '@/lib/guard';
import { MODEL, MAX_ITERATIONS, ORCHESTRATOR_MAX_TOKENS, todayISO } from '@/lib/config';
import { SYSTEM_PROMPT } from '@/lib/orchestrator/prompt';
import { TOOLS, dispatchTool } from '@/lib/orchestrator/tools';
import { applyHarness } from '@/lib/orchestrator/harness';
import { validateEnvelope } from '@/lib/orchestrator/validate';

// Allow up to 5 minutes for the multi-agent loop. Note that most serverless
// platforms cap below this (Vercel Hobby is 60s) — check your plan's limit.
export const maxDuration = 300;

const MAX_REPAIR_ATTEMPTS = 2;
// How much of each tool result to keep in the returned trace. Full outputs are
// held in memory for the harness but would make the response payload huge.
const TRACE_PREVIEW_CHARS = 4000;

export async function POST(request) {
  const blocked = guard(request, 'orchestrator', {
    limit: Number(process.env.RATE_LIMIT_ORCHESTRATOR_PER_MIN || 5),
  });
  if (blocked) return blocked;

  try {
    const input = await request.json();
    const {
      molecule,
      dosageForm,
      strength,
      targetMarkets = ['US'],
      objective,
    } = input;

    if (!molecule || typeof molecule !== 'string' || !molecule.trim()) {
      return NextResponse.json({ error: 'molecule is required' }, { status: 400 });
    }
    if (!strength || !String(strength).trim() || String(strength).toLowerCase() === 'unspecified') {
      return NextResponse.json(
        { error: 'strength is required and cannot be unspecified.' },
        { status: 400 },
      );
    }

    const today = todayISO();
    const initialPrompt = `Today's date is ${today}.

Run the full analysis for molecule: ${molecule}, dosage form: ${dosageForm}, strength: ${strength}. Markets: ${targetMarkets.join(', ')}. Objective: ${objective || 'not specified'}.`;

    const messages = [{ role: 'user', content: initialPrompt }];
    const executionTrace = [];
    const toolOutputs = []; // full outputs, kept for the harness
    let finalEnvelope = null;
    let iterations = 0;
    let repairAttempts = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await createMessage({
        max_tokens: ORCHESTRATOR_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      });

      cacheReadTokens += response.usage?.cache_read_input_tokens || 0;
      cacheWriteTokens += response.usage?.cache_creation_input_tokens || 0;

      const responseText = textOf(response);
      const toolUses = response.content.filter((c) => c.type === 'tool_use');

      messages.push({ role: 'assistant', content: response.content });

      if (toolUses.length > 0) {
        const results = await Promise.all(
          toolUses.map((call) => runTool(call, executionTrace, toolOutputs)),
        );

        const infraFailure = results.find((r) => r.infrastructure);
        if (infraFailure) {
          return NextResponse.json(
            {
              error: `Infrastructure failure in ${infraFailure.call.name}: ${infraFailure.errorMessage}`,
              status: 'ABORTED_NO_DATA',
              executionTrace,
            },
            { status: 503 },
          );
        }

        messages.push({
          role: 'user',
          content: results.map(({ call, result, isError }) => ({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
            ...(isError ? { is_error: true } : {}),
          })),
        });
        continue;
      }

      if (!responseText) {
        console.warn(`[orchestrator] iteration ${iterations}: no tool use and no text.`);
        break;
      }

      const parsed = extractJson(responseText);
      if (!parsed.ok) {
        if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
          finalEnvelope = { rawText: responseText, status: 'DEGRADED' };
          break;
        }
        repairAttempts++;
        messages.push({
          role: 'user',
          content: `Your output could not be parsed as JSON (${parsed.error}). Emit ONLY the raw JSON object — no prose, no markdown fence. If the previous output was truncated, shorten the text fields.`,
        });
        continue;
      }

      const envNode = parsed.value.developmentConstraintEnvelope || parsed.value;
      const errors = validateEnvelope(envNode);
      if (errors.length > 0) {
        if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
          console.warn('[orchestrator] emitting envelope with unresolved schema errors:', errors);
          finalEnvelope = wrap(parsed.value);
          finalEnvelope._schemaErrors = errors;
          break;
        }
        repairAttempts++;
        messages.push({
          role: 'user',
          content:
            `Your envelope failed schema validation:\n- ${errors.join('\n- ')}\n\n` +
            'Fix these and emit the corrected JSON object only. Field names are fixed — do not rename them; add extra fields alongside if you need more detail.',
        });
        continue;
      }

      finalEnvelope = wrap(parsed.value);
      break;
    }

    if (!finalEnvelope) {
      finalEnvelope = {
        rawText: 'No envelope could be parsed from the final model output.',
        status: 'DEGRADED',
        message:
          iterations >= MAX_ITERATIONS
            ? `Iteration ceiling (${MAX_ITERATIONS}) reached. Returning partial result.`
            : 'Agent terminated without output. Returning partial result.',
      };
    }

    let harnessResult = { blocking: [], advisory: [] };
    if (finalEnvelope.developmentConstraintEnvelope) {
      harnessResult = applyHarness(
        finalEnvelope.developmentConstraintEnvelope,
        toolOutputs,
        { today, dosageForm, strength, requestedMarkets: targetMarkets, molecule, objective },
      );
      finalEnvelope._harness = harnessResult;
    }

    return NextResponse.json({
      envelope: finalEnvelope,
      executionTrace,
      iterations,
      repairAttempts,
      model: MODEL,
      generatedAt: new Date().toISOString(),
      usage: {
        cacheReadInputTokens: cacheReadTokens,
        cacheCreationInputTokens: cacheWriteTokens,
      },
      input: { molecule, dosageForm, strength, targetMarkets, objective },
    });
  } catch (err) {
    console.error('[orchestrator]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Runs one tool call, recording both an auditable trace entry and the full output. */
async function runTool(call, executionTrace, toolOutputs) {
  const entry = {
    phase: `Tool Call: ${call.name}`,
    tool: call.name,
    input: call.input,
    timestamp: new Date().toISOString(),
  };
  executionTrace.push(entry);

  const started = Date.now();
  try {
    const result = await dispatchTool(call.name, call.input);
    entry.durationMs = Date.now() - started;

    if (result && result.error) {
      entry.status = 'error';
      entry.error = result.error;
      toolOutputs.push({ tool: call.name, input: call.input, status: 'error', output: null });
      return {
        call,
        result,
        isError: true,
        infrastructure: false,
        errorMessage: result.error,
      };
    }

    entry.status = 'success';
    entry.outputSummary =
      typeof result === 'object' && result !== null
        ? Object.keys(result).join(', ')
        : String(result).slice(0, 100);
    // The trace is the audit record: without the actual values there is no way
    // to check afterwards whether a claim limit came from BigQuery or memory.
    entry.outputPreview = preview(result);

    // `input` travels with the output: the harness needs the requested
    // operation to tell a range check from an expiry calculation.
    toolOutputs.push({ tool: call.name, input: call.input, status: 'success', output: result });
    return { call, result, isError: false, infrastructure: false };
  } catch (err) {
    entry.durationMs = Date.now() - started;
    entry.status = 'error';
    entry.error = err.message;
    toolOutputs.push({ tool: call.name, input: call.input, status: 'error', output: null });

    // Classify by the error's own status, not by substring-matching its text.
    // Matching on "404"/"429" inside a message misfires on any error that
    // happens to contain those digits (a patent number, a row count).
    const status = Number(err.status ?? err.statusCode ?? err.response?.status ?? 0);
    const infrastructure =
      status === 401 ||
      status === 403 ||
      status === 429 ||
      status >= 500 ||
      err.name === 'AbortError' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOTFOUND';

    return {
      call,
      result: { error: err.message, status: 'unavailable' },
      isError: true,
      infrastructure,
      errorMessage: err.message,
    };
  }
}

function preview(result) {
  try {
    const json = JSON.stringify(result);
    return json.length > TRACE_PREVIEW_CHARS
      ? `${json.slice(0, TRACE_PREVIEW_CHARS)}… [truncated, ${json.length} chars total]`
      : json;
  } catch {
    return '[unserializable]';
  }
}

function wrap(parsed) {
  return parsed.developmentConstraintEnvelope
    ? parsed
    : { version: '1.0.0', developmentConstraintEnvelope: parsed };
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : sliceBraces(text);
  if (!candidate) return { ok: false, error: 'no JSON object found in the response' };
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sliceBraces(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return text.substring(first, last + 1);
}
