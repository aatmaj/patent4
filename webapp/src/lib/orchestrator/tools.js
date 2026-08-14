import { patentFto } from '../agents/patentFto.js';
import { physchem } from '../agents/physchem.js';
import { orangeBook } from '../agents/orangeBook.js';
import { documentReason } from '../agents/documentReason.js';
import { arithmetic } from '../agents/arithmetic.js';
import { nlq } from '../agents/nlq.js';
import { rldProfile } from '../agents/rldProfile.js';

/**
 * Tool definitions and dispatcher.
 *
 * Agents are invoked as in-process functions. The orchestrator previously
 * fetched its own HTTP routes via NEXT_PUBLIC_BASE_URL, which doubled latency
 * per call, required the base URL to be correct in every environment, and
 * forced the sub-agent routes to stay publicly reachable even once auth sits
 * in front of the app.
 */

export const TOOLS = [
  {
    name: 'patent_fto_agent',
    description:
      'Query global patent databases and classify patents into the 6-layer FTO taxonomy (coreStructure, polymorph, formulation, processSynthesis, methodOfUse, combination) for a given molecule.',
    input_schema: {
      type: 'object',
      properties: {
        molecule: {
          type: 'string',
          description: 'USAN or INN name of the API (e.g. Semaglutide, Apixaban)',
        },
        dosageForm: {
          type: 'string',
          description: 'Dosage form context (e.g. Tablet, Injection, Ophthalmic)',
        },
        markets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two-letter country codes (e.g. US, EP, CN)',
        },
        seedPatentNumbers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Patent numbers from orange_book_agent. The landscape sweep matches TITLES only, so it ' +
            'misses patents whose title names a drug class rather than the molecule. Seeding with the ' +
            'Orange Book list recovers exactly the patents listed against the RLD.',
        },
      },
      required: ['molecule', 'dosageForm'],
    },
  },
  {
    name: 'physchem_agent',
    description:
      'Query ChEMBL to resolve molecules, fetch physicochemical properties (Mw, logP, PSA, HBA, HBD), and flag Ro5 violations. Returns a canonicalValues object; copy those numbers verbatim rather than retyping them.',
    input_schema: {
      type: 'object',
      properties: {
        moleculeName: { type: 'string', description: 'Common name of the molecule' },
        moleculeId: { type: 'string', description: 'ChEMBL ID or molregno' },
      },
      required: ['moleculeName'],
    },
  },
  {
    name: 'arithmetic',
    description:
      'Deterministic math — no LLM. REQUIRED for any numeric verdict.\n' +
      'in_range: is a value inside [lower, upper]? Use this for EVERY claim-coverage and ' +
      'concentration-match judgment — "does the RLD fall inside this claimed range" is a computation, ' +
      'not a reading. Handles cross-unit comparison (mg/mL vs % w/v) and refuses % w/w without density.\n' +
      'compare: a vs b. overlap: do two ranges intersect (does a product range touch a claimed range)?\n' +
      'Also: patent_expiry (filing + 20y + PTE/PTA); min / max over numbers; earliest / latest over ' +
      'dates; unit_convert; days_until; eval (bare arithmetic expression only).',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'in_range | compare | overlap | patent_expiry | min | max | earliest | latest | ' +
            'unit_convert | days_until | eval',
        },
        params: {
          type: 'object',
          description:
            'Every numeric operand must be a value some tool returned this session — a claim bound from ' +
            'document_reason, a concentration from rld_profile, a date from orange_book_agent — copied ' +
            'verbatim. Operands that appear in no tool output are rejected by the verification harness, ' +
            'because a deterministic comparison over an invented number still yields an invented verdict. ' +
            'Pass sourceRef naming where the numbers came from.\n' +
            'For in_range: { value, lower, upper, unit, valueUnit?, lowerUnit?, upperUnit?, ' +
            'lowerInclusive?, upperInclusive?, label?, sourceRef? }. For compare: { a, b, unit }. ' +
            'For overlap: { aLower, aUpper, bLower, bUpper, unit }. ' +
            'For patent_expiry: { filingDate, patent_term_extension_days, pta, pediatric }. ' +
            'For min/max/earliest/latest: { values: [...] }. For eval: { expression }.',
        },
      },
      required: ['operation', 'params'],
    },
  },
  {
    name: 'document_reason',
    description:
      'Schema-constrained extraction from patent claim text or FDA label text. Free-form summarization is ' +
      'PROHIBITED. Always provide an extractionSchema. Pass an empty text with a publication number and the ' +
      'agent retrieves the full claim text itself; the response reports exactly which ids were retrieved, ' +
      'and that is what determines U1 vs U2. Check retrievalFailures — a failed retrieval means you must ' +
      'NOT state that patent\u2019s claim boundaries.',
    input_schema: {
      type: 'object',
      properties: {
        documents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              fetchText: {
                type: 'boolean',
                description: 'Force full-text retrieval even when text is supplied.',
              },
            },
          },
          description: 'Array of documents with id and text fields',
        },
        question: {
          type: 'string',
          description: 'The specific question to answer from the documents',
        },
        extractionSchema: {
          type: 'object',
          description: 'JSON schema defining exactly what fields to extract',
        },
      },
      required: ['documents', 'question', 'extractionSchema'],
    },
  },
  {
    name: 'structured_query',
    description:
      'Convert a natural language question into a BigQuery SQL query over ChEMBL and FDA drug labels, and run it.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'rld_profile',
    description:
      "Retrieve the Reference Listed Drug's composition from its FDA label (openFDA SPL): the " +
      'inactive ingredients with their concentrations, the pH, and every marketed presentation with ' +
      'its strength. REQUIRED before any Q1/Q2 sameness claim on a 505(j) parenteral, where the RLD ' +
      'composition IS the formulation specification. This data is not in BigQuery — do not attempt ' +
      'to query it there. Presentations differ in composition (e.g. a preserved multi-dose pen vs a ' +
      'preservative-free single-dose syringe), so use the presentation matching the requested strength.',
    input_schema: {
      type: 'object',
      properties: {
        molecule: { type: 'string', description: 'Active ingredient, e.g. SEMAGLUTIDE' },
        applicationNumber: {
          type: 'string',
          description: 'FDA application number, e.g. NDA209637. Most precise; prefer it when known.',
        },
        brandName: { type: 'string', description: 'Brand name, e.g. Ozempic' },
        dosageForm: {
          type: 'string',
          description:
            'The dosage form or route being developed, e.g. "Injection", "Tablet". ALWAYS pass this. ' +
            'A brand name is not unique across routes — "Ozempic" matches both a subcutaneous ' +
            'injection and an oral tablet, which are different products with different compositions.',
        },
      },
      required: [],
    },
  },
  {
    name: 'orange_book_agent',
    description:
      'Fetch Orange Book patents, exclusivities, and FDA approval data from the openFDA API for a given molecule. Check coverage.patentsFound — zero means a data gap, not freedom to operate.',
    input_schema: {
      type: 'object',
      properties: {
        molecule: {
          type: 'string',
          description: 'The active ingredient name (e.g. SEMAGLUTIDE)',
        },
      },
      required: ['molecule'],
    },
  },
];

const HANDLERS = {
  patent_fto_agent: patentFto,
  physchem_agent: physchem,
  arithmetic,
  document_reason: documentReason,
  structured_query: nlq,
  orange_book_agent: orangeBook,
  rld_profile: rldProfile,
};

export async function dispatchTool(name, input) {
  const handler = HANDLERS[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}`, _errorKind: 'unknown_tool' };
  }
  return handler(input || {});
}
