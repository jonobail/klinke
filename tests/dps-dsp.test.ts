// Run with `npm test` (node --test; Node strips the types itself).
// Shared maths of the DPS-series effects (DPS-D7, DPS-M7, DPS-V55, DPS-V77).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Wave,
  evalHarmonics,
  gateCurve,
  pitchPlan,
  reverbIR,
  sawHarmonics,
  shiftHarmonics,
  tanhCurve,
  tapIR,
  timeKnob,
  waveHarmonics,
  windowHarmonics,
} from '../src/app/core/devices/dps-dsp.ts';
import {
  ER_SPAN,
  erTaps,
  longTaps,
  panTaps,
  reflectionTaps,
} from '../src/app/core/devices/dps-taps.ts';
import {
  DPS_EXTRA_FX,
  V55_FX,
  fxValues,
  knobText,
  knobValue,
} from '../src/app/core/devices/dps-fx.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const TAU = 2 * Math.PI;

test('LFO waves peak at ±1; special 1 and 2 are mirror images', () => {
  for (const w of [0, 1, 2, 3] as Wave[]) {
    const h = waveHarmonics(w);
    let peak = 0;
    for (let i = 0; i < 1000; i++)
      peak = Math.max(peak, Math.abs(evalHarmonics(h, (TAU * i) / 1000)));
    near(peak, 1, 0.02);
  }
  const s1 = waveHarmonics(2);
  const s2 = waveHarmonics(3);
  for (const t of [0.3, 1.7, 4]) near(evalHarmonics(s1, t), -evalHarmonics(s2, t), 1e-9);
  // Triangle: +1 at a quarter cycle, -1 at three quarters.
  near(evalHarmonics(waveHarmonics(1), Math.PI / 2), 1, 0.02);
  near(evalHarmonics(waveHarmonics(1), (3 * Math.PI) / 2), -1, 0.02);
});

test('a phase shift starts the wave that many degrees later', () => {
  const h = waveHarmonics(1);
  const shifted = shiftHarmonics(h, 90);
  for (const t of [0, 1, 2.5])
    near(evalHarmonics(shifted, t), evalHarmonics(h, t + Math.PI / 2), 1e-9);
});

test('pitch shifter: the taps sweep the delay at 1 − ratio, and the windows sum to one', () => {
  for (const ratio of [2, 0.5, Math.pow(2, 7 / 12), -1]) {
    const plan = pitchPlan(ratio, 0.06);
    // A rising sawtooth of gain `amp` and rate `freq` moves the delay by 2·amp·freq per second.
    near(2 * plan.amp * plan.freq, 1 - ratio, 1e-9);
    assert.ok(plan.centre > Math.abs(plan.amp), 'delay never reaches zero');
  }
  near(pitchPlan(1, 0.06).freq, 0);
  // Two windows half a cycle apart (plus their 0.5 base) always add to 1: no level wobble.
  const w = windowHarmonics();
  const w2 = shiftHarmonics(w, 180);
  for (const t of [0, 0.4, 2, 5])
    near(0.5 + evalHarmonics(w, t) + 0.5 + evalHarmonics(w2, t), 1, 1e-9);
  // The window is silent where the sawtooth jumps (θ = 0).
  near(0.5 + evalHarmonics(w, 0), 0, 1e-9);
  const saw = sawHarmonics();
  assert.ok(evalHarmonics(saw, 0.1) < -0.8 && evalHarmonics(saw, TAU - 0.1) > 0.8, 'rising saw');
});

test('time knob: square law to the range, never below the minimum', () => {
  near(timeKnob(1, 1.36531), 1.36531);
  near(timeKnob(0.5, 1), 0.25);
  near(timeKnob(0, 1.36521, 0.000021), 0.000021);
});

test('tap impulse: each tap lands at its time, panned with equal power', () => {
  const [l, r] = tapIR(
    [
      { time: 0.01, level: 1, pan: -1 },
      { time: 0.02, level: -0.5, pan: 0 },
    ],
    1000,
  );
  near(l[10], 1);
  near(r[10], 0);
  near(l[20], -0.5 * Math.SQRT1_2);
  near(r[20], -0.5 * Math.SQRT1_2);
});

test('reverb impulse: unit energy, decays about 60 dB over RT, deterministic', () => {
  const rate = 8000;
  const [l] = reverbIR({ seconds: 1, preDelay: 0.05, damp: 0.3, size: 1, early: 0.5 }, rate);
  let e = 0;
  for (const x of l) e += x * x;
  near(e, 1, 1e-6);
  for (let i = 0; i < 0.05 * rate - 1; i++) assert.equal(l[i], 0, 'predelay is silent');
  const rms = (t0: number) => {
    let s = 0;
    for (let i = Math.floor(t0 * rate); i < Math.floor((t0 + 0.05) * rate); i++) s += l[i] * l[i];
    return 10 * Math.log10(s);
  };
  const drop = rms(0.15) - rms(0.85);
  assert.ok(drop > 30 && drop < 60, `decay ${drop.toFixed(1)} dB over 0.7 s`);
  assert.deepEqual(
    reverbIR({ seconds: 1, preDelay: 0, damp: 0.3, size: 1, early: 0 }, rate)[1].slice(0, 50),
    reverbIR({ seconds: 1, preDelay: 0, damp: 0.3, size: 1, early: 0 }, rate)[1].slice(0, 50),
  );
  // RT 50 s is capped to a 6 s impulse.
  assert.ok(
    reverbIR({ seconds: 50, preDelay: 0, damp: 0, size: 1, early: 0 }, 1000)[0].length <= 6001,
  );
});

test('loop saturation is unity gain for small signals and bounded; the gate key steps', () => {
  const c = tanhCurve(4, 1025);
  near((c[513] - c[511]) / ((2 * 2 * 4) / 1024), 1, 1e-3);
  assert.ok(Math.max(...c) <= 1);
  const g = gateCurve(0.2);
  near(g[512], 0);
  near(g[1024], 1);
});

test('D7 tap patterns: 38 taps a side inside the range, levels tilted by the slope', () => {
  const taps = reflectionTaps(38, 1.2, 0.05, 1);
  assert.equal(taps.length, 76);
  for (const t of taps) assert.ok(t.time >= 0.05 && t.time <= 1.25 + 1e-9, String(t.time));
  const left = taps.filter((t) => t.pan < 0);
  assert.ok(Math.abs(left[0].level) > Math.abs(left[37].level), 'slope +1 dies away');
  const rising = reflectionTaps(38, 1.2, 0.05, -1).filter((t) => t.pan < 0);
  assert.ok(Math.abs(rising[0].level) < Math.abs(rising[37].level), 'slope -1 builds up');
  // Long Tap: taps on the spacing grid, then the full-level tap at the feedback time.
  const lg = longTaps(0.1, 0.55);
  assert.deepEqual(
    lg.map((t) => +t.time.toFixed(3)),
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.55],
  );
  assert.equal(longTaps(0.01, 2.7).length, 30, 'at most 29 taps plus the feedback tap');
  // Panpot taps walk left to right; the last is the main delay.
  const pt = panTaps(0.5);
  assert.deepEqual(
    pt.map((t) => t.pan),
    [-1, -0.5, 0, 0.5, 1],
  );
  near(pt[4].time, 0.5);
  // Early reflections stay inside the room type's span.
  for (let type = 0; type < 4; type++)
    for (const t of erTaps(type, 1, 0)) assert.ok(t.time <= ER_SPAN[type] + 0.0021);
});

test('effect knobs keep the guide ranges and convert to engine units', () => {
  const stdly = V55_FX.find((d) => d.code === 'StDLY')!;
  near(knobValue(stdly.knobs[0], 1), 1360);
  near(knobValue(stdly.knobs[2], 0), -99);
  const v = fxValues(stdly, [1, 0.5, 1]);
  near(v['time'], 1.36);
  near(v['fb'], 0.99);
  const hall = V55_FX.find((d) => d.code === 'Hall1')!;
  near(knobValue(hall.knobs[0], 0), 0.3);
  near(knobValue(hall.knobs[0], 1), 50);
  near(knobValue(hall.knobs[1], 1), 400);
  near(fxValues(hall, [0.5, 0, 1])['damp'], 0);
  const room2 = V55_FX.find((d) => d.code === 'Room2')!;
  near(knobValue(room2.knobs[0], 1), 20);
  assert.equal(knobText(V55_FX.find((d) => d.code === 'Rotry')!.knobs[0], 1), 'Fast');
  // Every effect has 1–3 knobs, a page and a unique code; numbers match the guide's list.
  const all = [...V55_FX, ...DPS_EXTRA_FX];
  assert.equal(new Set(all.map((d) => d.code)).size, all.length);
  for (const d of all) {
    assert.ok(d.knobs.length >= 1 && d.knobs.length <= 3, d.code);
    if (d.engine === 'pair') assert.ok(d.pair && d.ch === 'M-P', d.code);
  }
  for (const d of V55_FX) {
    const type = d.no <= 9 ? '4ch' : d.no <= 36 ? '2ch' : 'M-P';
    assert.equal(d.ch, type, `${d.code} is ${type} (guide p.2)`);
  }
});
