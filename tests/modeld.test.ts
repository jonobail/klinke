// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';
import { modelDSamples, modelDSettings } from '../src/app/core/modeld.ts';
import { MonoKeys, pinkNoise } from '../src/app/core/synth.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) =>
  modelDSettings({ ...defaultParams('modelD'), ...over });
const pos = (i: number, of = 6) => i / (of - 1);

test('every panel control is in a section exactly once (wheels and switches on the left-hand controller aside)', () => {
  const def = GEAR.modelD;
  const placed = def.sections!.flatMap((s) => (s.rows ?? []).flat().filter(Boolean));
  const leftHand = ['glideOn', 'decayOn', 'modWheel'];
  assert.deepEqual([...placed, ...leftHand].sort(), def.params.map((p) => p.id).sort());
});

test("defaults: two sawtooth oscillators at 8', osc 3 off and keyboard-controlled, filter tracking 1/3", () => {
  const s = at({});
  assert.deepEqual(
    s.osc.map((o) => o.wave),
    ['sawtooth', 'sawtooth', 'triangle'],
  );
  assert.deepEqual(
    s.osc.map((o) => o.ratio),
    [1, 1, 0.5],
  );
  assert.equal(s.osc[2].level, 0);
  assert.ok(s.osc[1].cents > 0 && s.osc[1].cents < 30, 'osc 2 slightly sharp for a fat unison');
  assert.equal(s.osc3Kbd, true);
  near(s.kbdTrack, 1 / 3);
  assert.equal(s.glide, 0, 'GLIDE knob does nothing until the GLIDE switch is on');
  assert.equal(s.volume > 0, true);
});

test("RANGE runs LO, 32'–2'; waveforms differ between osc 1/2 and osc 3", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => at({ osc1Range: pos(i) }).osc[0].ratio),
    [1 / 64, 0.25, 0.5, 1, 2, 4],
  );
  assert.equal(at({ osc1Wave: pos(1) }).osc[0].wave, 'trisaw');
  assert.equal(at({ osc3Wave: pos(1) }).osc[2].wave, 'revsaw');
  assert.equal(at({ osc2Wave: pos(5) }).osc[1].wave, 'narrow');
});

test('switches gate what they label', () => {
  assert.equal(at({ osc1On: 0 }).osc[0].level, 0);
  assert.equal(at({ noiseOn: 0, noiseVol: 1 }).noiseLevel, 0);
  assert.equal(at({ noiseOn: 1, noiseVol: 1 }).noiseLevel, 1);
  assert.equal(at({ mainOn: 0 }).volume, 0);
  assert.equal(at({ glideOn: 1, glide: 0.5 }).glide > 0, true);
  near(at({ kbd1: 1, kbd2: 1 }).kbdTrack, 1);
  near(at({ kbd1: 0, kbd2: 1 }).kbdTrack, 2 / 3);
});

test('contour times span 1 ms–10 s attack and 4 ms–35 s decay', () => {
  near(at({ fAttack: 0 }).filter.attack, 0.001);
  near(at({ lAttack: 1 }).loudness.attack, 10);
  near(at({ fDecay: 0 }).filter.decay, 0.004);
  near(at({ lDecay: 1 }).loudness.decay, 35);
  near(at({ osc2Freq: 1 }).osc[1].cents, 700);
});

test('waveforms: ramps run opposite ways, pulses have their widths', () => {
  const up = modelDSamples('sawtooth', 100);
  const down = modelDSamples('revsaw', 100);
  assert.ok(up[90] > up[10]);
  assert.ok(down[90] < down[10]);
  const share = (w: Float32Array) => w.filter((x) => x > 0).length / w.length;
  near(share(modelDSamples('square', 1000)), 0.5);
  near(share(modelDSamples('wide', 1000)), 0.3);
  near(share(modelDSamples('narrow', 1000)), 0.12);
  for (const w of ['triangle', 'trisaw'] as const) {
    const s = modelDSamples(w, 256);
    assert.ok(Math.max(...s) <= 1 && Math.min(...s) >= -1, w);
  }
});

test('mono keys, low-note priority: the lowest held key sounds', () => {
  const k = new MonoKeys('low');
  assert.deepEqual(k.press(60), { note: 60, trigger: true });
  assert.deepEqual(k.press(67), { note: 60, trigger: false }); // higher key: the C keeps sounding
  assert.deepEqual(k.press(55), { note: 55, trigger: false }); // lower key takes over, legato
  assert.deepEqual(k.lift(67), { note: 55, changed: false });
  assert.deepEqual(k.lift(55), { note: 60, changed: true }); // back up to the C
  assert.deepEqual(k.lift(60), { note: null, changed: true });
});

test('pink noise is deterministic, bounded and darker than white', () => {
  const a = pinkNoise(20000);
  assert.deepEqual(a, pinkNoise(20000));
  assert.ok(Math.max(...a.map(Math.abs)) < 1.5);
  // Sample-to-sample differences measure high-frequency energy: much less than the level itself.
  let level = 0;
  let diff = 0;
  for (let i = 1; i < a.length; i++) {
    level += a[i] * a[i];
    diff += (a[i] - a[i - 1]) ** 2;
  }
  assert.ok(diff < level, `${diff} < ${level}`); // white noise would give diff ≈ 2 × level
});
