// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KEY_NOTES,
  driveCurve,
  expMap,
  faderGain,
  meterLevel,
  mixSends,
  noteFreq,
  noteName,
  parseMidi,
  reverbImpulse,
  shiftBase,
} from '../src/app/core/sound.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('notes: A4 is 440 Hz, names follow MIDI octave numbering', () => {
  near(noteFreq(69), 440);
  near(noteFreq(81), 880);
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(49), 'C#3');
});

test('curves: exponential map, unity at three-quarter fader, equal-power mix', () => {
  near(expMap(0, 80, 16000), 80);
  near(expMap(1, 80, 16000), 16000);
  near(expMap(0.5, 100, 10000), 1000);
  near(faderGain(0.75), 1);
  assert.equal(faderGain(0), 0);
  for (const m of [0, 0.3, 1]) {
    const { dry, wet } = mixSends(m);
    near(dry * dry + wet * wet, 1);
  }
});

test('drive curve is odd, bounded and passes zero', () => {
  for (const d of [0, 0.5, 1]) {
    const c = driveCurve(d, 1025);
    near(c[512], 0);
    near(c[0], -1);
    near(c[1024], 1);
    near(c[100], -c[924]);
  }
  // More drive pushes small signals harder.
  assert.ok(driveCurve(1, 1025)[600] > driveCurve(0, 1025)[600]);
});

test('meter reads 0 for silence, 1 for full-scale, ~0.5 at -30 dB', () => {
  assert.equal(meterLevel(new Float32Array(64)), 0);
  near(meterLevel(new Float32Array(64).fill(1)), 1);
  near(meterLevel(new Float32Array(64).fill(10 ** (-30 / 20))), 0.5, 1e-4);
});

test('computer keyboard covers C to F an octave up; base shifts stay in range', () => {
  assert.equal(KEY_NOTES['KeyA'], 0);
  assert.equal(KEY_NOTES['KeyK'], 12);
  assert.equal(Math.max(...Object.values(KEY_NOTES)), 17);
  assert.equal(new Set(Object.values(KEY_NOTES)).size, Object.keys(KEY_NOTES).length);
  assert.equal(shiftBase(48, 1), 60);
  assert.equal(shiftBase(84, 1), 84);
  assert.equal(shiftBase(24, -1), 24);
});

test('MIDI: note on, note off, and note-on with zero velocity is an off', () => {
  assert.deepEqual(parseMidi([0x91, 60, 100]), { type: 'on', note: 60, velocity: 100 });
  assert.deepEqual(parseMidi([0x80, 60, 40]), { type: 'off', note: 60, velocity: 0 });
  assert.deepEqual(parseMidi([0x90, 60, 0]), { type: 'off', note: 60, velocity: 0 });
  assert.deepEqual(parseMidi([0xb0, 1, 127]), { type: 'cc', controller: 1, value: 1 }); // mod wheel
  assert.deepEqual(parseMidi([0xe0, 0, 64]), { type: 'bend', value: 0 }); // centre
  assert.deepEqual(parseMidi([0xe0, 0, 0]), { type: 'bend', value: -1 });
  assert.ok((parseMidi([0xe0, 127, 127]) as { value: number }).value > 0.999);
  assert.equal(parseMidi([0xf8]), null); // clock
});

test('reverb impulse is deterministic and decays', () => {
  const [l, r] = reverbImpulse(0.5, 8000);
  assert.equal(l.length, 4000);
  assert.notDeepEqual(l, r);
  assert.deepEqual(reverbImpulse(0.5, 8000)[0], l);
  const energy = (a: Float32Array, from: number, to: number) =>
    a.slice(from, to).reduce((s, x) => s + x * x, 0);
  assert.ok(energy(l, 0, 1000) > 10 * energy(l, 3000, 4000));
});
