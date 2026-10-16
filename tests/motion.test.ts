// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';
import {
  BEND_RANGE,
  DEFAULT_PATTERN,
  MAX_VOICES,
  PATTERN_STEPS,
  PRESETS,
  STEP_MAX,
  assignVoices,
  autoStepSeconds,
  autopilotOffsets,
  bendShapeAt,
  curveAt,
  decodeStatus,
  degreeSemis,
  dice,
  driftAt,
  encodeStatus,
  evolvePattern,
  glideTime,
  motionSettings,
  parsePattern,
  pathAt,
  reachable,
  releaseAt,
  rng,
  smoothNoise,
  spreadFactor,
  staggerDelays,
  startOffset,
  swellAt,
  vibratoAt,
  vibratoEnv,
} from '../src/app/core/motion.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) =>
  motionSettings({ ...defaultParams('motion'), ...over });

test('catalog: 14 × 7, NOTE IN left, NOTE OUT right, every param 0–1', () => {
  const g = GEAR.motion;
  assert.equal(g.category, 'midi');
  assert.deepEqual([g.w, g.h], [14, 7]);
  const [inJ, outJ] = g.jacks;
  assert.equal(inJ.id, 'notesIn');
  assert.equal(inJ.label, 'NOTE IN');
  assert.ok(inJ.fx < 0.05 && inJ.signal === 'note' && inJ.dir === 'in');
  assert.equal(outJ.id, 'notesOut');
  assert.equal(outJ.label, 'NOTE OUT');
  assert.ok(outJ.fx > 0.95 && outJ.signal === 'note' && outJ.dir === 'out');
  for (const p of g.params) assert.ok(p.default >= 0 && p.default <= 1, p.id);
});

test('settings: voice count 1–15, glide time and rate', () => {
  assert.equal(at({ voices: 0 }).voices, 1);
  assert.equal(at({ voices: 1 }).voices, MAX_VOICES);
  assert.equal(at({}).voices, 8);
  near(at({ glide: 1 }).glide, 4);
  near(at({ glideMode: 1, glide: 0 }).glide, 96);
  near(at({ glideMode: 1, glide: 1 }).glide, 2);
  near(at({ bendDepth: 0 }).bendDepth, -12);
  near(at({ bendDepth: 1 }).bendDepth, 12);
});

test('smart leading: voices keep their order and never cross', () => {
  // C E G → D F A: each moves up by step.
  assert.deepEqual(assignVoices([60, 64, 67], [62, 65, 69], 'SMART'), [0, 1, 2]);
  // Unordered inputs still pair in pitch order.
  assert.deepEqual(assignVoices([67, 60, 64], [69, 62, 65], 'SMART'), [0, 1, 2]);
  // Fewer notes: the voice that would move most is the one dropped.
  assert.deepEqual(assignVoices([60, 64, 67], [64, 67], 'SMART'), [-1, 0, 1]);
  // More notes: every voice is used, in order.
  const m = assignVoices([60, 67], [60, 64, 67], 'SMART');
  assert.deepEqual(m, [0, 2]);
});

test('classic leading: smallest total movement, crossing allowed', () => {
  const from = [60, 61];
  const to = [72, 59];
  const m = assignVoices(from, to, 'CLASSIC');
  // Smart (ordered) would be 60→59, 61→72 = 12; classic finds the same or better.
  const cost = m.reduce((sum, t, i) => sum + Math.abs(from[i] - to[t]), 0);
  assert.ok(cost <= 12);
  // A voice that's already there stays.
  assert.deepEqual(assignVoices([60, 64, 67], [67, 60, 64], 'CLASSIC'), [1, 2, 0]);
  // Every note gets one voice, none twice.
  const big = assignVoices([40, 50, 60, 70], [55, 65], 'CLASSIC');
  assert.deepEqual(big.filter((x) => x >= 0).sort(), [0, 1]);
  assert.deepEqual(assignVoices([], [60], 'CLASSIC'), []);
  assert.deepEqual(assignVoices([60], [], 'SMART'), [-1]);
});

test('bends reach ±48 semitones, beyond that a voice retriggers', () => {
  assert.equal(reachable(60, 60 + BEND_RANGE), BEND_RANGE);
  assert.equal(reachable(60, 59), -1);
  assert.equal(reachable(60, 60 + BEND_RANGE + 1), null);
});

test('curves run 0 → 1; ease in starts slow, ease out fast, overshoot passes the target', () => {
  for (const c of ['LINEAR', 'EASE IN', 'EASE OUT', 'S-CURVE', 'OVERSHOOT'] as const) {
    near(curveAt(c, 0), 0);
    near(curveAt(c, 1), 1);
  }
  assert.ok(curveAt('EASE IN', 0.3) < 0.3);
  assert.ok(curveAt('EASE OUT', 0.3) > 0.3);
  near(curveAt('S-CURVE', 0.5), 0.5);
  assert.ok(Math.max(...[0.6, 0.7, 0.8, 0.9].map((x) => curveAt('OVERSHOOT', x))) > 1);
});

test('paths: zero at both ends, arcs up / down in the middle, zigzag alternates', () => {
  for (const p of ['DIRECT', 'ARC UP', 'ARC DOWN', 'ZIGZAG', 'SWIRL'] as const) {
    near(pathAt(p, 0).pitch, 0);
    near(pathAt(p, 1).pitch, 0, 1e-9);
  }
  near(pathAt('ARC UP', 0.5).pitch, 1);
  near(pathAt('ARC DOWN', 0.5).pitch, -1);
  near(pathAt('ZIGZAG', 0.1, 1).pitch, -pathAt('ZIGZAG', 0.1, -1).pitch);
  assert.ok(pathAt('SWIRL', 0.5).timbre !== 0);
});

test('glide time: fixed in TIME mode, by distance in RATE mode; spread is stable', () => {
  assert.equal(glideTime({ rateMode: false, glide: 0.5 }, 12), 0.5);
  assert.equal(glideTime({ rateMode: true, glide: 24 }, 12), 0.5);
  assert.equal(glideTime({ rateMode: true, glide: 24 }, -12), 0.5);
  assert.equal(spreadFactor(3, 0), 1);
  assert.equal(spreadFactor(3, 1), spreadFactor(3, 1));
  for (let v = 0; v < 15; v++) {
    const f = spreadFactor(v, 1);
    assert.ok(f >= 0.25 && f <= 1.75);
  }
});

test('stagger orders', () => {
  const pitches = [64, 60, 67, 72];
  assert.deepEqual(staggerDelays(pitches, 'NONE', 1), [0, 0, 0, 0]);
  const up = staggerDelays(pitches, 'LOW→HIGH', 0.3);
  near(up[1], 0);
  near(up[0], 0.1);
  near(up[2], 0.2);
  near(up[3], 0.3);
  const down = staggerDelays(pitches, 'HIGH→LOW', 0.3);
  near(down[3], 0);
  near(down[1], 0.3);
  // Outside in: the outer pair first, then the inner pair.
  const oi = staggerDelays(pitches, 'OUTSIDE IN', 1);
  near(oi[1], 0);
  near(oi[3], 0);
  near(oi[0], 1);
  near(oi[2], 1);
  const io = staggerDelays(pitches, 'INSIDE OUT', 1);
  near(io[0], 0);
  near(io[2], 0);
  near(io[1], 1);
  // Odd count, inside out: the middle voice first.
  const odd = staggerDelays([60, 64, 67], 'INSIDE OUT', 1);
  near(odd[1], 0);
  near(odd[0], 1);
  near(odd[2], 1);
  const r = staggerDelays(pitches, 'RANDOM', 0.3, rng(4));
  assert.deepEqual(r.map((x) => Math.round(x * 10)).sort(), [0, 1, 2, 3]);
});

test('start bends', () => {
  const r = rng(1);
  assert.equal(startOffset('NONE', 5, 0, r), 0);
  assert.equal(startOffset('BELOW', 5, 0, r), -5);
  assert.equal(startOffset('ABOVE', 5, 0, r), 5);
  assert.equal(startOffset('ALTERNATE', 5, 0, r), -5);
  assert.equal(startOffset('ALTERNATE', 5, 1, r), 5);
  assert.ok(Math.abs(startOffset('RANDOM', 5, 0, r)) <= 5);
});

test('swell, vibrato delay, drift, release', () => {
  assert.equal(swellAt(0, 0), 1);
  near(swellAt(0, 1), 0.25);
  near(swellAt(1, 1), 1);
  assert.ok(swellAt(0.5, 1) > 0.25 && swellAt(0.5, 1) < 1);
  assert.equal(vibratoEnv(0.5, 1), 0);
  near(vibratoEnv(1.6, 1), 1);
  assert.equal(vibratoAt(0.5, 1, 5, 1), 0);
  assert.ok(Math.abs(vibratoAt(2.05, 1, 5, 1)) <= 1);
  for (let t = 0; t < 20; t += 0.37) assert.ok(Math.abs(driftAt(2, t, 30)) <= 0.3 + 1e-9);
  assert.notEqual(driftAt(1, 3.3, 30), driftAt(2, 3.3, 30));
  assert.equal(releaseAt('NONE', 12, 1), 0);
  near(releaseAt('FALL', 12, 1), -12);
  near(releaseAt('RISE', 12, 1), 12);
  near(releaseAt('FALL', 12, 0), 0);
});

test('smooth noise stays in range and is continuous', () => {
  let prev = smoothNoise(5, 0);
  for (let t = 0.01; t < 10; t += 0.01) {
    const v = smoothNoise(5, t);
    assert.ok(v >= -1 && v <= 1);
    assert.ok(Math.abs(v - prev) < 0.05);
    prev = v;
  }
});

test('global bend shapes', () => {
  near(bendShapeAt('OFF', 0.5, false), 0);
  near(bendShapeAt('RISE', 0.5, false), 0.5);
  near(bendShapeAt('RISE', 3, false), 1); // one-shot holds its end
  near(bendShapeAt('RISE', 1.25, true), 0.25); // looped
  near(bendShapeAt('FALL', 1, false), -1);
  near(bendShapeAt('ARCH', 0.5, false), 1);
  near(bendShapeAt('DIP', 0.5, false), -1);
  near(bendShapeAt('SAW', 1.5, false), 0); // always cyclic
});

test('scale degrees', () => {
  assert.equal(degreeSemis(0), 0);
  assert.equal(degreeSemis(2), 4);
  assert.equal(degreeSemis(4), 7);
  assert.equal(degreeSemis(7), 12);
  assert.equal(degreeSemis(-1), -1);
  assert.equal(degreeSemis(-7), -12);
});

test('patterns: parsed, cleaned, evolving', () => {
  assert.deepEqual(parsePattern(undefined), DEFAULT_PATTERN);
  assert.deepEqual(parsePattern('nonsense'), DEFAULT_PATTERN);
  assert.deepEqual(parsePattern('[1,2,3]'), DEFAULT_PATTERN);
  assert.deepEqual(parsePattern('[9,-9,1.4,0,0,0,0,0]'), [7, -7, 1, 0, 0, 0, 0, 0]);
  const r = rng(9);
  let pat = DEFAULT_PATTERN.slice();
  for (let i = 0; i < 200; i++) {
    const next = evolvePattern(pat, r);
    assert.equal(next.filter((v, j) => v !== pat[j]).length <= 1, true);
    assert.ok(next.every((v) => Math.abs(v) <= STEP_MAX));
    pat = next;
  }
});

test('autopilot: OFF is still, OCTAVES leap by octaves, WALK moves together', () => {
  const homes = [60, 64, 67];
  assert.deepEqual(autopilotOffsets('OFF', DEFAULT_PATTERN, 1, homes, 1), [0, 0, 0]);
  const oct = autopilotOffsets('OCTAVES', [1, -1, 0, 1, 1, 1, 1, 1], 0, homes, 1);
  assert.deepEqual(oct, [12, -12, 0]);
  // Amount 1/3: only the top voice takes part.
  assert.deepEqual(
    autopilotOffsets('OCTAVES', [1, 1, 1, 1, 1, 1, 1, 1], 0, homes, 0.34),
    [0, 0, 12],
  );
  assert.deepEqual(autopilotOffsets('WALK', [2, 0, 0, 0, 0, 0, 0, 0], 0, homes, 1), [4, 4, 4]);
});

test('autopilot: ARP-GLIDE moves one voice per step, BREATHE spreads, MIRROR inverts', () => {
  const homes = [60, 64, 67];
  const pat = [4, 4, 4, 4, 4, 4, 4, 4];
  for (let pos = 0; pos < 3; pos++) {
    const o = autopilotOffsets('ARP-GLIDE', pat, pos, homes, 1);
    assert.equal(o.filter((x) => x !== 0).length, 1);
    assert.equal(o[pos], 7);
  }
  const b = autopilotOffsets('BREATHE', [3, 0, 0, 0, 0, 0, 0, 0], 0, homes, 1);
  assert.deepEqual(b, [-3, 0, 3]);
  const m = autopilotOffsets('MIRROR', [1, 0, 0, 0, 0, 0, 0, 0], 0, homes, 1);
  // Mirrored about 63.5: 60 → 67, 64 → 63, 67 → 60.
  assert.deepEqual(
    homes.map((h, i) => h + m[i]),
    [67, 63, 60],
  );
  assert.deepEqual(autopilotOffsets('MIRROR', [0, 0, 0, 0, 0, 0, 0, 0], 0, homes, 1), [0, 0, 0]);
  const w1 = autopilotOffsets('WANDER', DEFAULT_PATTERN, 3, homes, 1, 5);
  assert.deepEqual(w1, autopilotOffsets('WANDER', DEFAULT_PATTERN, 3, homes, 1, 5));
  for (const o of w1) assert.ok(Math.abs(o) <= 24);
});

test('autopilot rate: synced to the tempo or free', () => {
  near(autoStepSeconds(at({ autoRate: 0.6 }), 120), 0.5); // 1/4 at 120 BPM
  near(autoStepSeconds(at({ autoRate: 0, autoSync: 1 }), 120), 4); // 2 bars
  near(autoStepSeconds(at({ autoRate: 1, autoSync: 0 }), 120), 1 / 12);
});

test('presets and dice only touch real params', () => {
  const ids = new Set(GEAR.motion.params.map((p) => p.id));
  for (const pr of PRESETS) {
    for (const [id, v] of Object.entries(pr.params)) {
      assert.ok(ids.has(id), `${pr.name}: ${id}`);
      assert.ok(v >= 0 && v <= 1);
    }
    if (pr.pattern) assert.equal(pr.pattern.length, PATTERN_STEPS);
  }
  const d = dice(rng(3));
  for (const [id, v] of Object.entries(d.params)) {
    assert.ok(ids.has(id), id);
    assert.ok(v >= 0 && v <= 1, `${id} ${v}`);
  }
  assert.equal(d.pattern.length, PATTERN_STEPS);
});

test('status line round trip', () => {
  const voices = [
    { id: 3, pitch: 60.25, pressure: 1, releasing: false },
    { id: 7, pitch: 71.5, pressure: 0.5, releasing: true },
  ];
  const back = decodeStatus(encodeStatus(voices, 4));
  assert.equal(back.step, 4);
  assert.equal(back.voices.length, 2);
  near(back.voices[0].pitch, 60.25);
  near(back.voices[1].pressure, 0.5, 0.01);
  assert.equal(back.voices[1].releasing, true);
  assert.deepEqual(decodeStatus(undefined), { step: -1, voices: [] });
  assert.deepEqual(decodeStatus(encodeStatus([], -1)).voices, []);
});
