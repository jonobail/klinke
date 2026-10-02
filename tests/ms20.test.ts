// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { mgSamples, ms20Settings } from '../src/app/core/ms20.ts';
import { MonoKeys, fourier, pulseSamples, stepIndex } from '../src/app/core/synth.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => ms20Settings({ ...defaultParams('ms20'), ...over });

test("defaults: VCO1 saw at 8', VCO2 square at 8' slightly sharp, centred knobs do nothing", () => {
  const s = at({});
  assert.equal(s.vco1Wave, 'sawtooth');
  assert.equal(s.vco1Ratio, 1);
  assert.equal(s.vco2Wave, 'square');
  assert.equal(s.vco2Ratio, 1);
  assert.ok(s.vco2Cents > 0 && s.vco2Cents < 100);
  for (const k of ['tuneCents', 'fmMgCents', 'hpfMgCents', 'lpfMgCents', 'hpfEg2Cents'] as const) {
    assert.equal(Math.abs(s[k]), 0, k);
  }
  assert.ok(s.lpfEg2Cents > 0, 'the default patch opens the low-pass with EG2');
  assert.equal(s.portamento, 0);
});

test('selector knobs: four wave forms and footages per VCO', () => {
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ vco1Wave: v }).vco1Wave),
    ['triangle', 'sawtooth', 'pulse', 'noise'],
  );
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ vco2Wave: v }).vco2Wave),
    ['sawtooth', 'square', 'narrow', 'ring'],
  );
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ vco1Scale: v }).vco1Ratio),
    [0.25, 0.5, 1, 2],
  ); // 32'–4'
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ vco2Scale: v }).vco2Ratio),
    [0.5, 1, 2, 4],
  ); // 16'–2'
  assert.equal(stepIndex(0.49, 4), 1);
});

test('ranges follow the service manual specifications', () => {
  near(at({ lpfCutoff: 0 }).lpfCutoff, 50);
  near(at({ lpfCutoff: 1 }).lpfCutoff, 15000);
  near(at({ hpfCutoff: 1 }).hpfCutoff, 15000);
  near(at({ vco2Pitch: 0 }).vco2Cents, -1200);
  near(at({ vco2Pitch: 1 }).vco2Cents, 1200);
  near(at({ tune: 1 }).tuneCents, 100);
  near(at({ mgFreq: 0 }).mgFreq, 0.1);
  near(at({ mgFreq: 1 }).mgFreq, 20);
  near(at({ eg1Delay: 1 }).eg1.delay, 10);
  near(at({ eg2Hold: 1 }).eg2.hold, 20);
  assert.equal(at({ eg2Attack: 0 }).eg2.attack, 0);
  near(at({ vco1Pw: 0 }).vco1Duty, 0.5); // 1:1
  assert.ok(at({ vco1Pw: 1 }).vco1Duty < 0.05); // toward 1:∞
  assert.ok(at({ lpfPeak: 1 }).lpfQ > 30); // self-oscillation territory
});

test('bipolar intensities are signed and symmetric', () => {
  near(at({ lpfMg: 0 }).lpfMgCents, -at({ lpfMg: 1 }).lpfMgCents);
  assert.ok(at({ hpfEg2: 0.2 }).hpfEg2Cents < 0);
  assert.ok(at({ fmMg: 0.6 }).fmMgCents > 0);
});

test('pulse samples have the requested duty and the Fourier terms rebuild them', () => {
  const pulse = pulseSamples(0.25, 400);
  assert.equal(pulse.filter((x) => x > 0).length, 100);
  // A square wave has only odd sine harmonics at 4/(nπ) (phase from the cosine-free start).
  const sq = fourier(pulseSamples(0.5, 1024), 5);
  near(Math.hypot(sq.real[1], sq.imag[1]), 4 / Math.PI, 0.01);
  near(Math.hypot(sq.real[2], sq.imag[2]), 0, 0.01);
  near(Math.hypot(sq.real[3], sq.imag[3]), 4 / (3 * Math.PI), 0.01);
});

test('MG wave skews from a falling ramp through a triangle to a rising ramp', () => {
  const tri = mgSamples(0.5, 100);
  near(tri[0], -1);
  near(tri[50], 1);
  const rise = mgSamples(1, 100);
  assert.ok(rise[90] > rise[10]); // still rising late in the cycle
  const fall = mgSamples(0, 100);
  assert.ok(fall[10] > fall[90]);
});

test('mono keys: last-note priority, single trigger, fall back to the held key', () => {
  const k = new MonoKeys();
  assert.deepEqual(k.press(60), { note: 60, trigger: true });
  assert.deepEqual(k.press(64), { note: 64, trigger: false }); // legato: no retrigger
  assert.deepEqual(k.lift(64), { note: 60, changed: true }); // back to the held C
  assert.deepEqual(k.lift(67), { note: 60, changed: false }); // stray key-up changes nothing
  assert.deepEqual(k.press(67), { note: 67, trigger: false });
  assert.deepEqual(k.lift(60), { note: 67, changed: false }); // lifting a key underneath
  assert.deepEqual(k.lift(67), { note: null, changed: true }); // all up: release
  assert.deepEqual(k.press(62), { note: 62, trigger: true });
});
