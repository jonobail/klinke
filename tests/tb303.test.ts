// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';
import { noteFreq } from '../src/app/core/sound.ts';
import {
  BASE_NOTE,
  PATTERNS,
  STEPS,
  type Pattern,
  type Step,
  clampTempo,
  decayTau,
  demoPattern,
  emptyPattern,
  envModCutoff,
  decodePattern,
  encodePattern,
  patternKey,
  patternsFromText,
  parseStatus,
  encodeStatus,
  pitchFromNote,
  resolvePattern,
  stepNote,
  stepSeconds,
  tb303Settings,
} from '../src/app/core/tb303.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => tb303Settings({ ...defaultParams('tb303'), ...over });

const step = (time: Step['time'], pitch = 0, more: Partial<Step> = {}): Step => ({
  pitch,
  oct: 0,
  accent: false,
  slide: false,
  time,
  ...more,
});
const pattern = (steps: Step[]): Pattern => ({
  length: steps.length,
  steps: [...steps, ...emptyPattern().steps].slice(0, STEPS),
});

test('catalog: NOTE IN / OUT and OUTPUT jacks, the six knobs, waveform and volume', () => {
  const def = GEAR.tb303;
  assert.equal(def.category, 'synth');
  for (const id of ['notesIn', 'notesOut', 'out']) assert.ok(def.jacks.some((j) => j.id === id));
  for (const id of ['tuning', 'cutoff', 'resonance', 'envMod', 'decay', 'accent', 'wave', 'volume'])
    assert.ok(
      def.params.some((p) => p.id === id),
      id,
    );
});

test('ranges follow the service notes', () => {
  near(at({ tuning: 0 }).tuneCents, -700); // approx. ±700 cents (spec)
  near(at({ tuning: 1 }).tuneCents, 700);
  near(at({ decay: 0 }).decay, 0.2); // DECAY VR MIN 200 ms, MAX 2.5 s (p.5)
  near(at({ decay: 1 }).decay, 2.5);
  near(Math.exp(-0.2 / decayTau(0.2)), 0.1); // "T" is the time to fall to 10 %
  near(at({ cutoff: 0.5 }).cutoff, Math.sqrt(70 * 3500)); // ≈ 500 Hz centre (p.7 VCF trim)
  assert.equal(at({ wave: 0 }).wave, 'saw');
  assert.equal(at({ wave: 1 }).wave, 'square');
  assert.equal(at({ pattern: 1 }).pattern, PATTERNS - 1);
  near(noteFreq(BASE_NOTE + 9), 110); // the A key is 110 Hz (p.5 TUNE trim)
  assert.equal(clampTempo(10), 40); // ♩ = 40 to 300 (spec)
  assert.equal(clampTempo(500), 300);
  near(stepSeconds(120), 0.125); // a step is a sixteenth
});

test('ENV MOD deepens the sweep and lowers the starting cutoff (p.8)', () => {
  assert.deepEqual(envModCutoff(0), { depth: 0, shift: -0 });
  const lo = envModCutoff(0.3);
  const hi = envModCutoff(0.9);
  assert.ok(hi.depth > lo.depth && hi.shift < lo.shift);
});

test('accent sweep grows with ACCENT and with RESONANCE (dual pot VR4)', () => {
  assert.equal(at({ accent: 0 }).sweep, 0);
  assert.ok(at({ accent: 1, resonance: 1 }).sweep > at({ accent: 1, resonance: 0 }).sweep);
});

test('pitch: key + DOWN / UP over three octaves; played notes fold into them', () => {
  assert.equal(stepNote({ pitch: 0, oct: -1 }), 24); // 1 V (p.6)
  assert.equal(stepNote({ pitch: 12, oct: 1 }), 60); // 4 V
  assert.deepEqual(pitchFromNote(36), { pitch: 0, oct: 0 });
  assert.deepEqual(pitchFromNote(48), { pitch: 12, oct: 0 });
  assert.deepEqual(pitchFromNote(43), { pitch: 7, oct: 0 });
  assert.deepEqual(pitchFromNote(30), { pitch: 6, oct: -1 });
  assert.deepEqual(pitchFromNote(55), { pitch: 7, oct: 1 });
  assert.deepEqual(pitchFromNote(62), { pitch: 2, oct: 1 }); // above the top: pitch class
  assert.deepEqual(pitchFromNote(14), { pitch: 2, oct: -1 });
  for (let n = 24; n <= 60; n++) assert.equal(stepNote(pitchFromNote(n)), n);
});

test('time: ties hold the note before, a tie after a rest is silent', () => {
  const r = resolvePattern(pattern([step('note', 3), step('tie'), step('rest'), step('tie')]));
  assert.deepEqual(
    r.map((p) => p.kind),
    ['note', 'tie', 'rest', 'rest'],
  );
  assert.equal(r[1].note, BASE_NOTE + 3);
  assert.equal(r[0].hold, true); // a tie follows: the gate stays open
  assert.equal(r[1].hold, false);
});

test('slide holds the gate into the next note, which glides without a new attack', () => {
  const r = resolvePattern(
    pattern([step('note', 0, { slide: true, accent: true }), step('note', 7), step('note', 5)]),
  );
  assert.equal(r[0].hold, true);
  assert.equal(r[0].accent, true);
  assert.equal(r[1].legato, true);
  assert.equal(r[1].hold, false);
  assert.equal(r[2].legato, false);
  // Slide into a rest does nothing; the pattern loops (last step into the first).
  const loop = resolvePattern(pattern([step('note', 0), step('note', 2, { slide: true })]));
  assert.equal(loop[0].legato, true);
  const intoRest = resolvePattern(pattern([step('note', 0, { slide: true }), step('rest')]));
  assert.equal(intoRest[0].hold, false);
});

test('pattern length loops early; all ties play nothing', () => {
  const p = { ...demoPattern(), length: 5 };
  assert.equal(resolvePattern(p).length, 5);
  assert.ok(resolvePattern(pattern([step('tie'), step('tie')])).every((s) => s.kind === 'rest'));
});

test('patterns round-trip through short patch text; junk comes back cleared', () => {
  const pats = patternsFromText(undefined);
  assert.equal(pats.length, PATTERNS);
  assert.deepEqual(pats[0], demoPattern());
  assert.deepEqual(pats[1], emptyPattern());
  const text = Object.fromEntries(pats.map((p, i) => [patternKey(i), encodePattern(p)]));
  assert.deepEqual(patternsFromText(text), pats);
  for (const v of Object.values(text)) assert.ok(v.length < 100); // patch text is capped at 500
  const p = { ...demoPattern(), length: 7 };
  assert.deepEqual(decodePattern(encodePattern(p), emptyPattern()), p);
  assert.deepEqual(decodePattern('not a pattern', emptyPattern()), emptyPattern());
  const odd = decodePattern('99:zzzz', demoPattern());
  assert.equal(odd.length, STEPS);
  assert.deepEqual(odd.steps[0], { pitch: 0, oct: 0, accent: false, slide: false, time: 'note' });
});

test('status: running and the step sounding', () => {
  assert.deepEqual(parseStatus(encodeStatus(true, 7)), { running: true, step: 7 });
  assert.deepEqual(parseStatus(undefined), { running: false, step: -1 });
});
