// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, INVENTORY, defaultParams } from '../src/app/core/gear.ts';
import {
  ACCENT_BIT,
  INSTRUMENTS,
  LOCATIONS,
  PATTERNS,
  SOUNDS,
  SOUND_NOTES,
  STEPS,
  bit,
  clampTempo,
  decodePattern,
  demoPattern,
  emptyPattern,
  encodeChain,
  encodePattern,
  encodeStatus,
  openHatTau,
  parseChain,
  parseStatus,
  patternIndex,
  patternKey,
  patternsFromText,
  pressLocation,
  setStep,
  soundForNote,
  stepHits,
  stepSeconds,
  toggleStep,
  tr606Settings,
} from '../src/app/core/tr606.ts';

test('catalog: NOTE IN / OUT and OUTPUT, the level knobs, on the shelf, no brand name', () => {
  const def = GEAR.tr606;
  assert.equal(def.category, 'synth');
  for (const id of ['notesIn', 'notesOut', 'out']) assert.ok(def.jacks.some((j) => j.id === id));
  for (const id of ['accent', 'bd', 'sd', 'tom', 'cy', 'hh', 'volume', 'group'])
    assert.ok(
      def.params.some((p) => p.id === id),
      id,
    );
  assert.ok(INVENTORY.includes('tr606'));
  assert.ok(!/roland|drumatix/i.test(JSON.stringify(def)));
});

test('seven sounds and an accent; 32 patterns of 16 steps', () => {
  assert.equal(SOUNDS.length, 7);
  assert.deepEqual(INSTRUMENTS.at(-1), 'AC');
  assert.equal(PATTERNS, 32);
  assert.equal(STEPS, 16);
  assert.equal(patternIndex(1, 0), LOCATIONS);
});

test('scales: sixteenths, thirty-seconds and the two triplet grids', () => {
  assert.equal(stepSeconds(120, 0), 0.125);
  assert.equal(stepSeconds(120, 1), 0.0625);
  assert.ok(Math.abs(stepSeconds(120, 2) - 0.5 / 3) < 1e-9);
  assert.ok(Math.abs(stepSeconds(120, 3) - 0.5 / 6) < 1e-9);
  assert.equal(clampTempo(10), 40);
  assert.equal(clampTempo(999), 300);
});

test('the open hi-hat rings longer at slow tempos', () => {
  assert.ok(openHatTau(60) > openHatTau(120));
  assert.ok(openHatTau(120) > openHatTau(240));
  assert.ok(openHatTau(40) <= 0.4 && openHatTau(300) >= 0.06);
});

test('levels: the toms and the hats share a knob each; accent lifts up to +6 dB', () => {
  const s = tr606Settings({ ...defaultParams('tr606'), tom: 0.5, hh: 0.8, accent: 1 });
  assert.equal(s.levels.LT, s.levels.HT);
  assert.equal(s.levels.OH, s.levels.CH);
  assert.equal(s.accent, 2);
  assert.equal(tr606Settings({ ...defaultParams('tr606'), accent: 0 }).accent, 1);
});

test('keys: the white keys play the instruments in panel order, in any octave', () => {
  const white = [0, 2, 4, 5, 7, 9, 11];
  for (const oct of [24, 36, 60])
    assert.deepEqual(
      white.map((w) => soundForNote(oct + w)),
      ['BD', 'SD', 'LT', 'HT', 'CY', 'OH', 'CH'],
    );
  assert.equal(soundForNote(42), 'CH'); // F♯: a GM closed hat
  assert.equal(soundForNote(46), 'OH'); // A♯: a GM open hat
  // NOTE OUT sends notes that play the same instrument back.
  for (const s of SOUNDS) assert.equal(soundForNote(SOUND_NOTES[s]), s);
});

test('patterns round-trip through text, and a bad one falls back', () => {
  const pat = { ...setStep(emptyPattern(), 3, 'OH'), length: 12, scale: 2 };
  pat.steps[0] = 0xff;
  assert.deepEqual(decodePattern(encodePattern(pat), emptyPattern()), pat);
  assert.deepEqual(decodePattern('nonsense', demoPattern()), demoPattern());
  assert.deepEqual(decodePattern(undefined, emptyPattern()), emptyPattern());
  const all = patternsFromText({ [patternKey(5)]: encodePattern(pat) });
  assert.equal(all.length, PATTERNS);
  assert.deepEqual(all[0], demoPattern());
  assert.deepEqual(all[5], pat);
  assert.deepEqual(all[6], emptyPattern());
});

test('the demo beat has a kick on the one, accented', () => {
  const { sounds, accent } = stepHits(demoPattern().steps[0]);
  assert.ok(sounds.includes('BD'));
  assert.ok(accent);
});

test('writing: toggling flips one instrument; TAP only adds', () => {
  let pat = toggleStep(emptyPattern(), 2, 'SD');
  assert.equal(pat.steps[2], bit('SD'));
  pat = toggleStep(pat, 2, 'AC');
  assert.equal(pat.steps[2], bit('SD') | ACCENT_BIT);
  pat = toggleStep(pat, 2, 'SD');
  assert.equal(pat.steps[2], ACCENT_BIT);
  assert.equal(setStep(setStep(pat, 2, 'AC'), 2, 'AC').steps[2], ACCENT_BIT);
  assert.deepEqual(stepHits(ACCENT_BIT), { sounds: [], accent: true });
});

test('chains stay inside one block of four', () => {
  assert.deepEqual(parseChain(undefined), [0]);
  assert.deepEqual(parseChain('2,1,1,9,x'), [1, 2]);
  let chain = pressLocation([0], 2, true);
  assert.deepEqual(chain, [0, 2]);
  chain = pressLocation(chain, 1, true);
  assert.deepEqual(chain, [0, 1, 2]);
  assert.deepEqual(pressLocation(chain, 5, true), [5]); // another block starts a new chain
  assert.deepEqual(pressLocation(chain, 1, true), [0, 2]); // pressed again: it leaves
  assert.deepEqual(pressLocation([3], 3, true), [3]); // the last one stays
  assert.deepEqual(pressLocation(chain, 7, false), [7]);
  assert.deepEqual(parseChain(encodeChain([4, 6])), [4, 6]);
});

test('status round-trips', () => {
  assert.deepEqual(parseStatus(encodeStatus(true, 5, 17)), { running: true, step: 5, pattern: 17 });
  assert.deepEqual(parseStatus(undefined), { running: false, step: -1, pattern: -1 });
});
