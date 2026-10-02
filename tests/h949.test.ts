// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import {
  FUNCTIONS,
  MEMORY_SECONDS,
  RANDOM_MAX,
  coarseMs,
  delaySetMs,
  h949,
  h949Settings,
  phaseB,
  rampCycle,
  spliceCurves,
  spliceGain,
  ssbHz,
  vcoRatio,
  wanderNoise,
} from '../src/app/core/devices/h949.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const fn = (f: (typeof FUNCTIONS)[number]) => FUNCTIONS.indexOf(f) / (FUNCTIONS.length - 1);
const at = (over: Record<string, number>) => h949Settings({ ...defaultParams('h949'), ...over });
/** MANUAL position for a VCO pitch ratio. */
const ratioKnob = (r: number) => (r - 0.25) / 1.75;

test('memory: 16K samples at 41 kHz is 0.4 s; the delay switches add up to just under it', () => {
  near(MEMORY_SECONDS, 0.3996, 1e-4);
  near(delaySetMs(0), 0);
  near(delaySetMs(1), 393.75);
  near(delaySetMs(16 / 64 + 1e-6), 100);
  assert.ok(delaySetMs(1) / 1000 < MEMORY_SECONDS);
  near(coarseMs(393.75), 350);
  near(coarseMs(49), 0);
});

test('VCO pitch ratio 0.25–2 (two octaves down, one up), linear in the MANUAL pot', () => {
  near(vcoRatio(0), 0.25);
  near(vcoRatio(1), 2);
  near(at({ pitch: ratioKnob(1.5) }).ratio, 1.5);
  near(at({}).ratio, 1.5); // default: a fifth up
});

test('the pointer drifts through the 25 ms window at |1 − ratio|, and splices that often', () => {
  const up = at({ function: fn('NORMAL'), pitch: ratioKnob(2) });
  assert.equal(up.window, 0.025);
  assert.equal(up.direction, -1); // reading faster: the delay shrinks
  near(up.spliceHz, 1 / 0.025);
  const down = at({ function: fn('NORMAL'), pitch: ratioKnob(0.5) });
  assert.equal(down.direction, 1);
  near(down.spliceHz, 0.5 / 0.025);
  near(at({ function: fn('NORMAL'), pitch: ratioKnob(1) }).spliceHz, 0, 1e-9);
  near(at({ function: fn('EXTEND'), pitch: ratioKnob(2) }).spliceHz, 1 / 0.05);
  // REVERSE reads backwards: the delay grows by 1 + ratio per second.
  const rev = at({ function: fn('REVERSE'), pitch: ratioKnob(1) });
  assert.equal(rev.direction, 1);
  near(rev.spliceHz, 2 / 0.05);
});

test('µPC uses the SSB: ratio 1 ± f / 82 kHz, about 0.93–1.07', () => {
  near(ssbHz(1, 'UPC#'), 6000);
  near(at({ function: fn('UPC#'), pitch: 1 }).ratio, 1 + 6000 / 82000);
  near(at({ function: fn('UPCB'), pitch: 1 }).ratio, 1 - 6000 / 82000);
  near(at({ function: fn('UPC#'), pitch: 0 }).ratio, 1 + 20 / 82000);
  assert.ok(at({ function: fn('UPC#') }).pitchMode);
});

test('FLANGE sweeps 7.5–17.5 ms at the SSB slope; RANDOM stays inside 2.5–22.5 ms', () => {
  const f = at({ function: fn('FLANGE'), pitch: 1 });
  near(f.ratio, 1 + 600 / 82000);
  // Triangle: 10 ms up and 10 ms down per cycle at 600 / 82000 s/s.
  near(f.flangeHz, 600 / 82000 / 0.02);
  assert.ok(!f.pitchMode);
  const r = at({ function: fn('RANDOM'), pitch: 1 });
  assert.ok(r.randomDepth > 0 && 0.0125 + 3.5 * r.randomDepth <= RANDOM_MAX + 1e-12);
  const n = wanderNoise(10, 3000);
  let sq = 0;
  for (const v of n) sq += v * v;
  near(Math.sqrt(sq / n.length), 1, 1e-3);
});

test('DELAY uses every MAIN switch; other functions only 50 / 100 / 200', () => {
  near(at({ function: fn('DELAY'), mainDelay: 1 }).base, 0.39375);
  near(at({ function: fn('NORMAL'), mainDelay: 1 }).base, 0.35);
  near(at({ function: fn('NORMAL'), mainDelay: 0.1 }).base, 0);
  assert.equal(at({ function: fn('DELAY') }).spliceHz, 0);
});

test('splice curves: ALG 2 raised cosines sum to one; ALG 1 holds one pointer most of the time', () => {
  // ALG 2: OUTB's own raised cosine (half a cycle on) is exactly 1 − OUTA's.
  for (const phi of [0, 0.1, 0.3, 0.5, 0.77, 0.99])
    near(spliceGain(phi, 2) + spliceGain(phaseB(phi), 2), 1, 1e-9);
  // Each pointer is silent at its own splice (the wrap of its position).
  const c1 = spliceCurves(1, 101);
  for (const i of [0, 100]) near(c1.gainA[i], 0);
  for (let i = 0; i <= 100; i++) if (Math.abs(c1.posB[i]) > 0.98) near(c1.gainB[i], 0, 0.05);
  // Silent at its own splice point.
  near(spliceGain(0, 2), 0);
  near(spliceGain(0, 1), 0);
  near(spliceGain(0.5, 1), 1);
  near(spliceGain(0.05, 1), 0.5);
  const c = spliceCurves(2, 101);
  near(c.gainA[50], 1);
  near(c.gainB[50], 0);
  near(c.posB[0], 0); // OUTB is mid-window while OUTA splices
  const r = rampCycle(4);
  assert.deepEqual([...r], [-1, -0.5, 0, 0.5]);
});

test('display: pitch ratio, function and the two delay settings', () => {
  assert.equal(h949.display!(defaultParams('h949')), '1.500 NORM PC\nM0 D100');
  const all = h949.display!({
    ...defaultParams('h949'),
    function: fn('REVERSE'),
    mainDelay: 1,
    dlyDelay: 1,
    pitch: 0,
  });
  assert.ok(all.length <= 24, all);
});
