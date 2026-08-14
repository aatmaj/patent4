import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrength, matchPresentation, concentrationsMatch } from '../src/lib/strength.js';
import { parsePresentationBlocks, parsePh } from '../src/lib/agents/rldProfile.js';

test('a concentration and a content-per-volume are not the same thing', () => {
  assert.equal(parseStrength('1 mg/mL').mgPerMl, 1);
  assert.equal(parseStrength('1 mg/mL').kind, 'concentration');

  // 1 mg in 0.5 mL is 2 mg/mL — reading it as "1 mg/mL" analyses a different
  // presentation, and on a Q1/Q2 pathway presentations differ in composition.
  const perVolume = parseStrength('1 mg/0.5 mL');
  assert.equal(perVolume.mgPerMl, 2);
  assert.equal(perVolume.totalMg, 1);
  assert.equal(perVolume.volumeMl, 0.5);
  assert.equal(perVolume.kind, 'content-per-volume');
});

test('parseStrength handles units and unparseable input', () => {
  assert.equal(parseStrength('500mg').kind, 'mass');
  assert.equal(parseStrength('500mg').mgPerMl, null);
  assert.equal(parseStrength('1000 mcg/mL').mgPerMl, 1);
  assert.equal(parseStrength('').kind, 'unparsed');
  assert.equal(parseStrength('one milligram').kind, 'unparsed');
});

test('concentrationsMatch tolerates label rounding', () => {
  // The label states 1.34 mg/mL; 4 mg / 3 mL is exactly 1.3333...
  assert.ok(concentrationsMatch(1.34, 4 / 3));
  assert.ok(!concentrationsMatch(1.34, 2.68));
});

// The real Ozempic Description section: two presentation blocks, each with its
// own container volume and its own inactive-ingredient list.
const OZEMPIC_DESCRIPTION =
  'OZEMPIC is a sterile, aqueous, clear, colorless solution. Each 3 mL prefilled, single-patient-use pen ' +
  'contains semaglutide 2 mg (0.68 mg/mL), 4 mg (1.34 mg/mL), or 8 mg (2.68 mg/mL). Each 1 mL of OZEMPIC ' +
  'solution also contains the following inactive ingredients: disodium phosphate dihydrate, 1.42 mg; ' +
  'propylene glycol, 14 mg; phenol, 5.5 mg; and water for injections. OZEMPIC has a pH of approximately 7.4. ' +
  'Hydrochloric acid or sodium hydroxide may be added to adjust pH. Each 0.5 mL single-dose syringe contains ' +
  'a solution of OZEMPIC containing 0.25 mg, 0.5 mg or 1 mg of semaglutide. Each 1 mL of OZEMPIC contains ' +
  'the following inactive ingredients: disodium phosphate dihydrate, 1.42 mg; sodium chloride, 8.25 mg; ' +
  'and water for injection. OZEMPIC has a pH of approximately 7.4.';

test('the label splits into presentation blocks by container', () => {
  const blocks = parsePresentationBlocks(OZEMPIC_DESCRIPTION);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].containerVolumeMl, 3);
  assert.equal(blocks[0].containerType, 'multi-dose pen');
  assert.equal(blocks[1].containerVolumeMl, 0.5);
  assert.equal(blocks[1].containerType, 'single-dose syringe');
});

test('each presentation carries the composition of ITS OWN container', () => {
  // The failure this guards against: attributing composition by prose
  // proximity gave every presentation the syringe's preservative-free
  // composition, so a multi-dose pen's Q1/Q2 target lost phenol entirely.
  const presentations = parsePresentationBlocks(OZEMPIC_DESCRIPTION).flatMap((b) => b.presentations);

  const pen = presentations.find((p) => p.label === '4 mg/3 mL');
  const penNames = pen.composition.ingredients.map((i) => i.name);
  assert.equal(pen.containerType, 'multi-dose pen');
  assert.ok(penNames.includes('phenol'));
  assert.ok(penNames.includes('propylene glycol'));
  assert.ok(!penNames.includes('sodium chloride'));

  const syringe = presentations.find((p) => p.label === '0.5 mg/0.5 mL');
  const syringeNames = syringe.composition.ingredients.map((i) => i.name);
  assert.equal(syringe.containerType, 'single-dose syringe');
  assert.ok(syringeNames.includes('sodium chloride'));
  assert.ok(!syringeNames.includes('phenol'), 'a single-dose syringe carries no preservative');
});

test('the ingredient list survives the periods inside its own amounts', () => {
  // A [^.]+ terminator stops at the "." in "1.42 mg" and matches nothing.
  const pen = parsePresentationBlocks(OZEMPIC_DESCRIPTION)[0].composition;
  assert.equal(pen.ingredients.find((i) => i.name === 'phenol').amount, 5.5);
  assert.equal(pen.ingredients.find((i) => i.name === 'disodium phosphate dihydrate').amount, 1.42);
  assert.equal(pen.ingredients.find((i) => i.name === 'propylene glycol').amount, 14);
});

test('excipient amounts are not mistaken for product strengths', () => {
  const pen = parsePresentationBlocks(OZEMPIC_DESCRIPTION)[0];
  const totals = pen.presentations.map((p) => p.totalMg).sort((a, b) => a - b);
  assert.deepEqual(totals, [2, 4, 8], 'only the semaglutide strengths, not 1.42/14/5.5');
});

test('pH parsing does not swallow the sentence-ending period', () => {
  // [\d.]+ captures "7.4." and Number("7.4.") is NaN.
  assert.equal(parsePh(OZEMPIC_DESCRIPTION).value, 7.4);
});

test('a requested strength resolves to the presentation that actually has it', () => {
  const presentations = parsePresentationBlocks(OZEMPIC_DESCRIPTION).flatMap((b) => b.presentations);

  // 0.5 mg in 0.5 mL IS 1 mg/mL — a real presentation, not an invalid input.
  const one = matchPresentation('1 mg/mL', presentations);
  assert.equal(one.status, 'MATCH');
  assert.equal(one.match.containerType, 'single-dose syringe');

  // 1.34 mg/mL is the multi-dose pen — a different composition entirely.
  const pen = matchPresentation('1.34 mg/mL', presentations);
  assert.equal(pen.status, 'MATCH');
  assert.equal(pen.match.containerType, 'multi-dose pen');
});

test('a strength with no matching presentation reports the real ones', () => {
  const presentations = parsePresentationBlocks(OZEMPIC_DESCRIPTION).flatMap((b) => b.presentations);
  const out = matchPresentation('7 mg/mL', presentations);
  assert.equal(out.status, 'NO_MATCH');
  assert.equal(out.match, null);
  assert.equal(out.candidates.length, 6);
});

test('a label with no container blocks yields nothing rather than guessing', () => {
  assert.deepEqual(parsePresentationBlocks('RYBELSUS tablets contain 3 mg, 7 mg or 14 mg.'), []);
  assert.deepEqual(parsePresentationBlocks(''), []);
});
