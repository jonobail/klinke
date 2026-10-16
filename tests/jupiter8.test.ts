// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';
import {
  Jp8Assigner,
  Jupiter8Dsp,
  arpPeriod,
  arpeggio,
  dspParams,
  envKeyScale,
  jupiter8Settings,
} from '../src/app/core/jupiter8.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number> = {}) =>
  jupiter8Settings({ ...defaultParams('jupiter8'), ...over });

test('catalog entry: 61 keys, NOTE IN / OUT and OUT, model name only', () => {
  const def = GEAR.jupiter8;
  assert.deepEqual(def.keyboard, { from: -12, keys: 61 });
  const ids = def.jacks.map((j) => j.id);
  for (const id of ['notesIn', 'notesOut', 'out']) assert.ok(ids.includes(id), id);
  assert.ok(!/roland/i.test(JSON.stringify(def)));
  const params = def.params.map((p) => p.id);
  assert.equal(new Set(params).size, params.length, 'unique params');
});

test('ranges follow the specification', () => {
  near(at({ lfoRate: 0 }).lfoRate, 0.05);
  near(at({ lfoRate: 1 }).lfoRate, 40);
  near(at({ lfoDelay: 1 }).lfoDelay, 4);
  near(at({ env1A: 0 }).env1.a, 0.001);
  near(at({ env1A: 1 }).env1.a, 5);
  near(at({ env2D: 1 }).env2.d, 10);
  near(at({ env2R: 1 }).env2.r, 10);
  near(at({ fine2: 0 }).fine2, -50);
  near(at({ fine2: 1 }).fine2, 50);
  near(at({ keyFollow: 1 }).keyFollow, 1.2);
  near(at({ arpRate: 0, arpClock: 0 }).arpHz, 1);
  near(at({ arpRate: 1, arpClock: 0 }).arpHz, 20);
  assert.deepEqual(
    [0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => at({ range1: v }).oct1),
    [-3, -2, -1, 0, 1, 2],
  ); // 64'–2'
  assert.equal(at({ slope: 0 }).slope24, false);
  assert.equal(at({ slope: 1 }).slope24, true);
  // VCO MOD destinations
  assert.deepEqual(
    [0, 0.5, 1].map((v) => [at({ modDest: v }).modVco1, at({ modDest: v }).modVco2]),
    [
      [true, false],
      [true, true],
      [false, true],
    ],
  );
  // SOURCE MIX: VCO-1 alone, both, VCO-2 alone
  assert.deepEqual([at({ sourceMix: 0 }).mix1, at({ sourceMix: 0 }).mix2], [1, 0]);
  assert.deepEqual([at({ sourceMix: 0.5 }).mix1, at({ sourceMix: 0.5 }).mix2], [1, 1]);
  assert.deepEqual([at({ sourceMix: 1 }).mix1, at({ sourceMix: 1 }).mix2], [0, 1]);
  assert.equal(at({ porta: 0 }).portaTime, 0);
});

test('arpeggio clock: rate on INT, note values of the tempo on EXT', () => {
  near(arpPeriod(at({ arpClock: 0, arpRate: 1 }), 120), 1 / 20);
  near(arpPeriod(at({ arpClock: 1, arpRate: 0 }), 120), 0.5); // 1/4 at 120 BPM
  near(arpPeriod(at({ arpClock: 1, arpRate: 0.6 }), 120), 0.125); // 1/16
});

test('arpeggio orders over 1–4 octaves', () => {
  assert.deepEqual(arpeggio([64, 60, 67], 'up', 1), [60, 64, 67]);
  assert.deepEqual(arpeggio([64, 60], 'up', 2), [60, 64, 72, 76]);
  assert.deepEqual(arpeggio([64, 60], 'down', 2), [76, 72, 64, 60]);
  assert.deepEqual(arpeggio([60, 64, 67], 'updown', 1), [60, 64, 67, 64]);
  assert.deepEqual(arpeggio([60], 'updown', 2), [60, 72]);
  assert.equal(arpeggio([60, 64], 'random', 4).length, 8);
  assert.deepEqual(arpeggio([60], 'off', 1), []);
});

test('envelope key follow: faster up the keyboard', () => {
  near(envKeyScale(60), 1);
  near(envKeyScale(84), 0.5);
  near(envKeyScale(36), 2);
});

test('assigner: POLY 1 takes the voices in turn', () => {
  const a = new Jp8Assigner();
  a.setMode('poly1');
  const v1 = a.press(60)[0];
  a.release(60);
  const v2 = a.press(60)[0];
  assert.equal(v1.type, 'on');
  assert.notEqual(v1.voice, v2.voice);
});

test('assigner: POLY 2 gives a key back its own voice', () => {
  const a = new Jp8Assigner();
  a.setMode('poly2');
  const first = a.press(60)[0];
  a.press(64);
  a.release(60);
  a.release(64);
  assert.equal(a.press(60)[0].voice, first.voice);
});

test('assigner: eight voices, then the oldest note is stolen', () => {
  const a = new Jp8Assigner();
  const used = new Set<number>();
  for (let n = 0; n < 8; n++) used.add(a.press(60 + n)[0].voice);
  assert.equal(used.size, 8);
  assert.equal(a.busy, 8);
  const stolen = a.press(80)[0];
  assert.equal(stolen.voice, [...used][0]);
  assert.deepEqual(a.release(60), []); // its voice moved on
});

test('assigner: UNISON plays all voices, SOLO one, last-note priority, legato return', () => {
  const a = new Jp8Assigner();
  a.setMode('unison');
  assert.equal(a.press(60).length, 8);
  const back = a.press(64);
  assert.ok(back.every((x) => x.type === 'on' && x.note === 64 && x.retrigger));
  const ret = a.release(64);
  assert.ok(ret.every((x) => x.type === 'on' && x.note === 60 && !x.retrigger));
  assert.ok(a.release(60).every((x) => x.type === 'off'));

  const solo = new Jp8Assigner();
  solo.setMode('solo');
  assert.deepEqual(solo.press(60), [{ type: 'on', voice: 0, note: 60, retrigger: true }]);
  assert.deepEqual(solo.release(60), [{ type: 'off', voice: 0 }]);
});

// ── DSP ──────────────────────────────────────────────────

/** The DSP as the worklet gets it: rebuilt from its source text alone. */
const standalone = () => new Function(`return (${Jupiter8Dsp.toString()})`)() as typeof Jupiter8Dsp;

const SR = 48000;
function play(over: Record<string, number>, notes: number[], seconds: number, release = 0) {
  const Dsp = standalone();
  const dsp = new Dsp(SR);
  dsp.message({ type: 'params', params: dspParams(at(over)) });
  notes.forEach((note, voice) =>
    dsp.message({ type: 'on', time: 0, voice, note, retrigger: true }),
  );
  if (release)
    for (let v = 0; v < notes.length; v++) dsp.message({ type: 'off', time: release, voice: v });
  const out = new Float32Array(Math.round(seconds * SR));
  const block = new Float32Array(128);
  for (let i = 0; i + 128 <= out.length; i += 128) {
    dsp.render(block, i / SR);
    out.set(block, i);
  }
  return out;
}
const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

test('DSP: stands alone (worklet source), sounds, and dies away after release', () => {
  const out = play({}, [60], 1.5, 0.5);
  assert.ok(out.every(Number.isFinite));
  assert.ok(rms(out, 4800, 24000) > 0.01, 'audible while held');
  assert.ok(rms(out, out.length - 4800) < 1e-3, 'silent after the release');
});

test('DSP: SLOPE, SYNC and CROSS MOD change the sound', () => {
  const base = { cutoff: 0.6, res: 0, vcfEnv: 0, sourceMix: 0.5, wave2: 1 / 3 };
  const a = play({ ...base, slope: 1 }, [48], 0.3);
  const b = play({ ...base, slope: 0 }, [48], 0.3);
  assert.ok(Math.abs(rms(a, 4800) - rms(b, 4800)) > 1e-3, '12 vs 24 dB');
  const sync = play({ ...base, sync: 1, range2: 0.8 }, [48], 0.3);
  const free = play({ ...base, sync: 0, range2: 0.8 }, [48], 0.3);
  assert.ok(
    sync.some((x, i) => Math.abs(x - free[i]) > 1e-3),
    'sync',
  );
  const xm = play({ ...base, crossMod: 0.3 }, [48], 0.3);
  const plain = play(base, [48], 0.3);
  assert.ok(
    xm.some((x, i) => Math.abs(x - plain[i]) > 1e-3),
    'cross mod',
  );
});

test('DSP: resonance at full stays bounded', () => {
  const out = play({ res: 1, cutoff: 0.5 }, [36, 48, 60, 64, 67, 72, 76, 79], 0.5);
  assert.ok(out.every((x) => Number.isFinite(x) && Math.abs(x) < 4));
});

test('DSP: eight voices render well inside real time', () => {
  const t0 = performance.now();
  play({ sync: 1, crossMod: 0.2, wave1: 2 / 3, wave2: 2 / 3 }, [48, 52, 55, 59, 60, 64, 67, 71], 2);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `2 s of audio took ${ms.toFixed(0)} ms`);
});
