import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, textOf, toolUseOf } from '../src/lib/gemini.js';
import { THINKING_RESERVE_TOKENS } from '../src/lib/config.js';

/**
 * The translation layer is the whole of the Gemini migration, so it is tested
 * against a stubbed transport rather than the live API: these assertions are
 * about the shape crossing the wire, which is exactly what a live call would
 * hide behind a plausible-looking answer.
 */

process.env.GEMINI_API_KEY ||= 'test-key';

/** Runs `createMessage` against a canned response; returns [request, response]. */
async function withStub(geminiResponse, args) {
  const real = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => geminiResponse,
    };
  };
  try {
    const response = await createMessage(args);
    return [captured, response];
  } finally {
    globalThis.fetch = real;
  }
}

const textReply = (text) => ({
  candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 40 },
  modelVersion: 'gemini-3.1-pro-preview',
});

test('system string becomes systemInstruction, not a message', async () => {
  const [req] = await withStub(textReply('ok'), {
    system: 'You are terse.',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.deepEqual(req.body.systemInstruction, { parts: [{ text: 'You are terse.' }] });
  assert.equal(req.body.contents.length, 1);
  assert.deepEqual(req.body.contents[0], { role: 'user', parts: [{ text: 'hi' }] });
});

test('cacheable system blocks are flattened to text', async () => {
  const [req] = await withStub(textReply('ok'), {
    system: [{ type: 'text', text: 'Rules.', cache_control: { type: 'ephemeral' } }],
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.deepEqual(req.body.systemInstruction, { parts: [{ text: 'Rules.' }] });
  assert.equal(JSON.stringify(req.body).includes('cache_control'), false);
});

test('max_tokens is raised by the thinking reserve', async () => {
  // Gemini bills reasoning against maxOutputTokens; Anthropic did not. Passing
  // the caller's number through unchanged truncates the answer.
  const [req] = await withStub(textReply('ok'), {
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(req.body.generationConfig.maxOutputTokens, 512 + THINKING_RESERVE_TOKENS);
});

test('tools use parametersJsonSchema so free-form object args survive', async () => {
  const [req] = await withStub(textReply('ok'), {
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'arithmetic',
        description: 'math',
        input_schema: {
          type: 'object',
          properties: { operation: { type: 'string' }, params: { type: 'object' } },
          required: ['operation', 'params'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'arithmetic' },
  });

  const decl = req.body.tools[0].functionDeclarations[0];
  assert.equal(decl.name, 'arithmetic');
  // `parameters` would drop `params` — it has no declared properties.
  assert.equal(decl.parameters, undefined);
  assert.equal(decl.parametersJsonSchema.properties.params.type, 'object');
  assert.deepEqual(req.body.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['arithmetic'] },
  });
});

test('a tool_use / tool_result round trip keeps names, ids and signatures', async () => {
  const messages = [
    { role: 'user', content: 'analyse' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'orange_book_agent',
          input: { molecule: 'SEMAGLUTIDE' },
          _thoughtSignature: 'sig-abc',
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: JSON.stringify({ patents: [{ patent_number: '9750788' }] }),
        },
      ],
    },
  ];

  const [req] = await withStub(textReply('done'), { max_tokens: 100, messages });

  const [, modelTurn, toolTurn] = req.body.contents;
  assert.equal(modelTurn.role, 'model');
  assert.deepEqual(modelTurn.parts[0].functionCall, {
    id: 'call_1',
    name: 'orange_book_agent',
    args: { molecule: 'SEMAGLUTIDE' },
  });
  // Gemini 3 needs the signature back to carry reasoning across the tool call.
  assert.equal(modelTurn.parts[0].thoughtSignature, 'sig-abc');

  assert.equal(toolTurn.role, 'user');
  // functionResponse is keyed by name; the name is resolved from the tool_use.
  assert.equal(toolTurn.parts[0].functionResponse.name, 'orange_book_agent');
  assert.deepEqual(toolTurn.parts[0].functionResponse.response, {
    patents: [{ patent_number: '9750788' }],
  });
});

test('a failed tool result is marked as an error for the model', async () => {
  const [req] = await withStub(textReply('done'), {
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'nlq', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '"timed out"', is_error: true },
        ],
      },
    ],
  });

  assert.deepEqual(req.body.contents[2].parts[0].functionResponse.response, {
    result: 'timed out',
    error: true,
  });
});

test('functionCall parts map back to Anthropic tool_use blocks', async () => {
  const [, response] = await withStub(
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Calling the classifier.' },
              {
                functionCall: { id: 'call_9', name: 'classify_patents', args: { formulation: [] } },
                thoughtSignature: 'sig-xyz',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 300,
        cachedContentTokenCount: 64,
      },
    },
    { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  );

  assert.equal(textOf(response), 'Calling the classifier.');
  const use = toolUseOf(response);
  assert.equal(use.id, 'call_9');
  assert.equal(use.name, 'classify_patents');
  assert.deepEqual(use.input, { formulation: [] });
  assert.equal(use._thoughtSignature, 'sig-xyz');
  assert.equal(response.stop_reason, 'tool_use');
  assert.equal(response.usage.cache_read_input_tokens, 64);
  assert.equal(response.usage.thinking_tokens, 300);
});

test('thought parts are not mistaken for answer text', async () => {
  const [, response] = await withStub(
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Let me think about the schema...', thought: true },
              { text: 'SELECT 1' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {},
    },
    { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  );

  assert.equal(textOf(response), 'SELECT 1');
  assert.equal(response.content.length, 1);
});

test('truncation is reported as max_tokens rather than a clean stop', async () => {
  const [, response] = await withStub(
    {
      candidates: [
        { content: { role: 'model', parts: [{ text: '{"partial":' }] }, finishReason: 'MAX_TOKENS' },
      ],
      usageMetadata: {},
    },
    { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  );

  assert.equal(response.stop_reason, 'max_tokens');
});

test('an HTTP failure carries its status so the orchestrator can classify it', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: new Headers(),
    text: async () => JSON.stringify({ error: { message: 'API key not valid' } }),
  });
  try {
    await assert.rejects(
      createMessage({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        // The orchestrator switches on err.status to tell an infrastructure
        // failure from a tool-logic one; a bare Error would be misclassified.
        assert.equal(err.status, 401);
        assert.match(err.message, /API key not valid/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('a blocked prompt fails loudly instead of returning empty text', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
  });
  try {
    await assert.rejects(
      createMessage({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      /blocked the prompt: SAFETY/,
    );
  } finally {
    globalThis.fetch = real;
  }
});
