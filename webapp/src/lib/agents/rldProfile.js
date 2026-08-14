import { HTTP_TIMEOUT_MS } from '../config.js';

/**
 * RLD profile agent — the reference product's composition, from its FDA label.
 *
 * For an ANDA 505(j) parenteral, 21 CFR 314.94(a)(9)(iii) makes the RLD's
 * inactive ingredients and their concentrations the entire formulation
 * specification. That data lives in the Structured Product Label, exposed
 * through openFDA `/drug/label.json`.
 *
 * Two things this agent has to get right, because both silently produce a wrong
 * Q1/Q2 target rather than an error:
 *
 *  1. THE RIGHT PRODUCT. A brand name is not unique across routes — "Ozempic"
 *     matches both the subcutaneous injection (NDA209637) and an oral tablet
 *     (NDA213051). Selection is therefore route-aware.
 *
 *  2. THE RIGHT PRESENTATION. A label describes several presentations whose
 *     compositions differ — Ozempic's 3 mL multi-dose pen is preserved with
 *     phenol and propylene glycol; its 0.5 mL single-dose syringe uses sodium
 *     chloride and no preservative. The label states these as blocks ("Each
 *     3 mL ... pen contains ... Each 1 mL also contains the following inactive
 *     ingredients: ..."), so composition is attributed by CONTAINER VOLUME
 *     rather than by prose proximity.
 */
const ENDPOINT = 'https://api.fda.gov/drug/label.json';

/** Route words that indicate a parenteral product, for route matching. */
const ROUTE_SYNONYMS = {
  injection: ['SUBCUTANEOUS', 'INTRAVENOUS', 'INTRAMUSCULAR', 'PARENTERAL', 'INFUSION'],
  injectable: ['SUBCUTANEOUS', 'INTRAVENOUS', 'INTRAMUSCULAR', 'PARENTERAL'],
  subcutaneous: ['SUBCUTANEOUS'],
  intravenous: ['INTRAVENOUS'],
  oral: ['ORAL'],
  tablet: ['ORAL'],
  capsule: ['ORAL'],
  topical: ['TOPICAL', 'CUTANEOUS'],
  ophthalmic: ['OPHTHALMIC'],
};

export async function rldProfile({ molecule, applicationNumber, brandName, route, dosageForm }) {
  if (!molecule && !applicationNumber && !brandName) {
    const err = new Error(
      'Provide at least one of: molecule, applicationNumber (e.g. NDA209637), brandName.',
    );
    err.status = 400;
    throw err;
  }

  const wantedRoutes = resolveRoutes(route || dosageForm);

  // Tried in priority order rather than OR'd into one query: an OR lets
  // openFDA's ranking choose, which returned the oral product for a request
  // that named the injection's brand.
  const attempts = [];
  if (applicationNumber) {
    attempts.push({
      by: 'applicationNumber',
      q: `openfda.application_number:"${lucene(normaliseAppNumber(applicationNumber))}"`,
    });
  }
  if (brandName) attempts.push({ by: 'brandName', q: `openfda.brand_name:"${lucene(brandName)}"` });
  if (molecule) {
    attempts.push({
      by: 'molecule',
      q: `openfda.generic_name:"${lucene(molecule)}" OR openfda.substance_name:"${lucene(molecule)}"`,
    });
  }

  let chosen = null;
  let matchedBy = null;
  let lastStatus = 404;
  const rejected = [];

  for (const attempt of attempts) {
    // limit=25: a brand can span several applications and routes, and the one
    // we want is not necessarily openFDA's top-ranked hit.
    const url = `${ENDPOINT}?search=${encodeURIComponent(attempt.q)}&limit=25`;
    const response = await fetchJson(url);
    lastStatus = response.status;

    if (response.body?.error && response.status !== 404) {
      throw new Error(
        `openFDA error ${response.body.error.code || response.status}: ${response.body.error.message || 'unknown'}`,
      );
    }
    const results = Array.isArray(response.body?.results) ? response.body.results : [];
    if (results.length === 0) continue;

    const picked = pickByRoute(results, wantedRoutes);
    if (picked.record) {
      chosen = picked.record;
      matchedBy = attempt.by;
      rejected.push(...picked.rejected);
      break;
    }
    // Every hit was the wrong route — record them and try the next attempt
    // rather than returning a product the caller did not ask for.
    rejected.push(...picked.rejected);
  }

  if (!chosen) {
    return {
      status: 'NO_DATA',
      source: 'openFDA drug/label (SPL)',
      message:
        rejected.length > 0
          ? `No label matched route ${wantedRoutes ? wantedRoutes.join('/') : '(any)'}. Rejected: ${rejected
              .map((r) => `${r.applicationNumber || '?'} (${r.route || 'route unknown'})`)
              .join('; ')}.`
          : `No FDA label found for ${applicationNumber || brandName || molecule}.`,
      requestedRoute: wantedRoutes,
      rejectedCandidates: rejected,
      presentations: [],
      compositions: [],
      httpStatus: lastStatus,
      coverage: {
        presentationsFound: 0,
        note: 'No label retrieved for the requested route. The RLD composition is UNKNOWN — it must not be asserted from recall.',
      },
      evidenceClass: 'S1',
    };
  }

  const openfda = chosen.openfda || {};
  const descriptionText = joinSection(chosen.description);
  const strengthsText = joinSection(chosen.dosage_forms_and_strengths);

  const blocks = parsePresentationBlocks(descriptionText);
  const presentations = blocks.flatMap((b) => b.presentations);
  const compositions = blocks.filter((b) => b.composition).map((b) => b.composition);

  return {
    status: 'SUCCESS',
    source: 'openFDA drug/label (SPL)',
    rld: {
      brandName: first(openfda.brand_name),
      genericName: first(openfda.generic_name),
      applicationNumber: first(openfda.application_number),
      manufacturer: first(openfda.manufacturer_name),
      route: first(openfda.route),
      splId: first(openfda.spl_id),
      splSetId: first(openfda.spl_set_id),
      matchedBy,
    },
    requestedRoute: wantedRoutes,
    rejectedCandidates: rejected,
    splIngredientNames: parseSplElements(chosen.spl_product_data_elements),
    presentationBlocks: blocks.map((b) => ({
      containerVolumeMl: b.containerVolumeMl,
      containerType: b.containerType,
      strengthCount: b.presentations.length,
      hasComposition: !!b.composition,
      pH: b.pH,
    })),
    presentations,
    compositions,
    pH: blocks.find((b) => b.pH)?.pH ?? parsePh(descriptionText),
    labelSections: {
      description: descriptionText || null,
      dosageFormsAndStrengths: strengthsText || null,
      howSupplied: joinSection(chosen.how_supplied) || null,
    },
    coverage: {
      presentationsFound: presentations.length,
      compositionsParsed: compositions.length,
      presentationsWithComposition: presentations.filter((p) => p.composition).length,
      note:
        compositions.length === 0
          ? 'The label was retrieved but no inactive-ingredient list could be parsed. Extract from labelSections.description rather than asserting a composition.'
          : 'Composition attributed per presentation by container volume. Verify each value against labelSections.description before filing use.',
    },
    evidenceClass: 'U1',
    evidenceClassReason:
      'Values parsed from FDA label text retrieved this session (primary document).',
    retrievedAt: new Date().toISOString(),
  };
}

/* ── product selection ─────────────────────────────────────────────────── */

function resolveRoutes(hint) {
  if (!hint) return null;
  const key = String(hint).trim().toLowerCase();
  for (const [word, routes] of Object.entries(ROUTE_SYNONYMS)) {
    if (key.includes(word)) return routes;
  }
  return null;
}

/**
 * Choose the record whose route matches. With no hint, the first record is
 * used but every alternative is still reported so a mismatch is visible.
 */
function pickByRoute(results, wantedRoutes) {
  const described = results.map((r) => ({
    record: r,
    applicationNumber: first(r.openfda?.application_number),
    brandName: first(r.openfda?.brand_name),
    route: first(r.openfda?.route),
  }));

  if (!wantedRoutes) {
    return { record: described[0].record, rejected: described.slice(1).map(strip) };
  }

  const match = described.find((d) =>
    wantedRoutes.some((w) => String(d.route || '').toUpperCase().includes(w)),
  );
  if (!match) return { record: null, rejected: described.map(strip) };
  return {
    record: match.record,
    rejected: described.filter((d) => d !== match).map(strip),
  };
}

function strip(d) {
  return { applicationNumber: d.applicationNumber, brandName: d.brandName, route: d.route };
}

/* ── label parsing ─────────────────────────────────────────────────────── */

const CONTAINER_WORDS = 'pen|syringe|vial|cartridge|autoinjector|auto-injector|ampoule|ampule';

/**
 * Split the Description section into presentation blocks.
 *
 * A block opens at "Each <volume> ... <container> contains ..." and runs until
 * the next such opening. Everything inside — the strengths, the inactive
 * ingredient list, the pH — belongs to that presentation.
 *
 * Attributing by container volume is what makes the pen/syringe distinction
 * reliable. Keyword proximity does not: in the real Ozempic label every
 * presentation ends up labelled "single-dose" because the phrase appears in
 * both blocks, which silently gave the preserved multi-dose pens the
 * preservative-free syringe composition.
 */
export function parsePresentationBlocks(text) {
  if (!text) return [];

  const opener = new RegExp(
    `Each\\s+(\\d+(?:\\.\\d+)?)\\s*(mL|L)\\b([^.]{0,120}?)\\b(${CONTAINER_WORDS})\\b`,
    'gi',
  );

  const starts = [];
  let m;
  while ((m = opener.exec(text)) !== null) {
    starts.push({
      index: m.index,
      volumeMl: m[2].toLowerCase() === 'l' ? Number(m[1]) * 1000 : Number(m[1]),
      qualifier: m[3] || '',
      container: m[4],
    });
  }
  if (starts.length === 0) return [];

  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const body = text.slice(start.index, end);
    const containerType = classifyContainer(start.qualifier, start.container, body);

    // Strengths are stated before the inactive-ingredient list; splitting there
    // keeps excipient amounts out of the strength list.
    const split = body.search(/inactive ingredients?/i);
    const strengthPart = split === -1 ? body : body.slice(0, split);

    const stated = [...strengthPart.matchAll(/\(([\d.]+)\s*(mg|mcg|g)\s*\/\s*(mL|L)\)/gi)].map((s) =>
      toMg(Number(s[1]), s[2]) / (s[3].toLowerCase() === 'l' ? 1000 : 1),
    );

    const masses = [...strengthPart.matchAll(/([\d.]+)\s*(mg|mcg|g)\b(?!\s*\/)/gi)]
      .map((s) => toMg(Number(s[1]), s[2]))
      .filter((v) => Number.isFinite(v) && v > 0);

    const composition = parseComposition(body, containerType, start.volumeMl);
    const pH = parsePh(body);

    const seen = new Set();
    const presentations = [];
    masses.forEach((totalMg, idx) => {
      const concentration = round6(totalMg / start.volumeMl);
      const key = `${totalMg}|${start.volumeMl}`;
      if (seen.has(key)) return;
      seen.add(key);
      presentations.push({
        label: `${trimNumber(totalMg)} mg/${trimNumber(start.volumeMl)} mL`,
        strength: `${trimNumber(totalMg)} mg/${trimNumber(start.volumeMl)} mL`,
        totalMg: round6(totalMg),
        volumeMl: round6(start.volumeMl),
        concentrationMgPerMl: concentration,
        // The label's own rounded per-mL figure, when it gives one.
        statedConcentrationMgPerMl:
          stated.length === masses.length ? round6(stated[idx]) : null,
        containerType,
        context: containerType,
        composition,
        pH,
      });
    });

    return {
      containerVolumeMl: start.volumeMl,
      containerType,
      presentations,
      composition,
      pH,
      raw: body.trim().slice(0, 600),
    };
  });
}

function classifyContainer(qualifier, container, body) {
  const hay = `${qualifier} ${container} ${body.slice(0, 200)}`.toLowerCase();
  const isPen = /pen|cartridge/.test(container.toLowerCase());
  const multi = /multi[-\s]?dose|multiple\s+(weekly\s+)?doses|single-patient-use/.test(hay);
  if (isPen) return multi ? 'multi-dose pen' : 'pen';
  if (/syringe/.test(container.toLowerCase())) {
    return /single[-\s]?dose/.test(hay) ? 'single-dose syringe' : 'syringe';
  }
  if (/vial/.test(container.toLowerCase())) {
    return multi ? 'multi-dose vial' : 'single-dose vial';
  }
  return container.toLowerCase();
}

/** The inactive-ingredient list inside one presentation block. */
function parseComposition(body, containerType, containerVolumeMl) {
  // Terminated on a sentence boundary, not on any period — the amounts contain
  // decimal points ("1.42 mg"), which truncates a [^.]+ terminator.
  const m = body.match(
    /Each\s+(\d+(?:\.\d+)?\s*m?L)[^.]*?inactive ingredients?:\s*([\s\S]+?)(?=\.\s+[A-Z]|\.\s*$|$)/i,
  );
  if (!m) return null;
  const ingredients = parseIngredientList(m[2]);
  if (ingredients.length === 0) return null;
  return {
    basis: m[1].replace(/\s+/g, ' ').trim(),
    context: containerType,
    containerType,
    containerVolumeMl,
    ingredients,
    raw: m[0].trim(),
  };
}

function parseIngredientList(segment) {
  return segment
    .split(/;|,\s*and\s+|\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const withAmount = part.match(/^(.+?),\s*([\d.]+)\s*(mg|mcg|g|%\s*w\/w|%\s*w\/v|%)\s*$/i);
      if (withAmount) {
        return {
          name: cleanName(withAmount[1]),
          amount: Number(withAmount[2]),
          unit: withAmount[3].replace(/\s+/g, '').toLowerCase(),
        };
      }
      const name = cleanName(part);
      return name ? { name, amount: null, unit: null } : null;
    })
    .filter(Boolean);
}

function cleanName(s) {
  return s
    .replace(/^(?:the following\s+)?inactive ingredients?:?\s*/i, '')
    .replace(/[.;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePh(text) {
  if (!text) return null;
  // (\d+(?:\.\d+)?) rather than [\d.]+ — the latter eats the sentence's
  // trailing period, so "pH of approximately 7.4." yields Number("7.4.") = NaN.
  const m = text.match(
    /pH\s*(?:of|is|:)?\s*(?:approximately|about|~)?\s*(\d+(?:\.\d+)?)\s*(?:(?:[-–]|to)\s*(\d+(?:\.\d+)?))?/i,
  );
  if (!m) return null;
  return { value: Number(m[1]), upper: m[2] ? Number(m[2]) : null, raw: m[0].trim() };
}

const MASS_TO_MG = { mcg: 0.001, ug: 0.001, mg: 1, g: 1000 };

function toMg(value, unit) {
  const factor = MASS_TO_MG[String(unit).toLowerCase()];
  return factor != null && Number.isFinite(value) ? value * factor : NaN;
}

function trimNumber(n) {
  return Number(n.toFixed(6)).toString();
}

function round6(n) {
  return Number(n.toFixed(6));
}

function parseSplElements(elements) {
  const joined = joinSection(elements);
  if (!joined) return [];
  return [...new Set(joined.split(/\s{2,}|\n/).map((s) => s.trim()).filter(Boolean))];
}

function joinSection(section) {
  if (!section) return '';
  return Array.isArray(section) ? section.join(' ') : String(section);
}

function first(v) {
  return Array.isArray(v) ? v[0] : (v ?? null);
}

function normaliseAppNumber(n) {
  const s = String(n).toUpperCase().replace(/\s+/g, '');
  return /^(NDA|ANDA|BLA)/.test(s) ? s : `NDA${s.replace(/\D/g, '')}`;
}

function lucene(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`openFDA returned HTTP ${res.status} with a non-JSON body`);
      throw new Error('openFDA returned a non-JSON body');
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`openFDA label request timed out after ${HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
