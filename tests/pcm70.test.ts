// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { focusTracker } from '../src/app/core/devices/pcm-display.ts';
import {
  CHORDS,
  chordHz,
  combDelay,
  combFeedback,
  decayEnv,
  diffusionBurst,
  irSeconds,
  links,
  loopGain,
  lowpassDelay,
  midiHz,
  minLoopDelay,
  roomImpulse,
} from '../src/app/core/devices/pcm-dsp.ts';
import { PCM70_PROGRAMS, pcm70, pcm70Settings } from '../src/app/core/devices/pcm70.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const prog = (num: string) => PCM70_PROGRAMS.findIndex((x) => x.num === num) / 13;
const at = (num: string, over: Record<string, number> = {}) =>
  pcm70Settings({ ...defaultParams('pcm70'), program: prog(num), ...over });
const energy = (x: Float32Array, from: number, to: number) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return e;
};

test('the programs: bulletin 070-04662 numbers, and every family §2.1 names', () => {
  assert.equal(PCM70_PROGRAMS.length, 14);
  const nums = PCM70_PROGRAMS.map((x) => x.num);
  assert.deepEqual([...nums].sort(), nums, 'panel order');
  for (const n of ['0.0', '0.3', '0.7', '0.8', '0.9', '1.1', '1.3', '1.8', '6.1']) {
    assert.ok(nums.includes(n), n);
  }
  const families = new Set(PCM70_PROGRAMS.map((x) => x.family));
  for (const f of ['chorusEcho', 'multiband', 'chords', 'hall', 'chamber', 'plate']) {
    assert.ok(families.has(f as never), f);
  }
  // The program selector lists them all, defaulting to 3.0 CONCERT HALL.
  const sel = pcm70.params.find((x) => x.id === 'program')!;
  assert.equal(sel.steps, 14);
  assert.equal(pcm70Settings(defaultParams('pcm70')).program.name, 'CONCERT HALL');
});

test('every delay network stays bounded: each loop passes a FEEDBACK link below unity', () => {
  for (const topology of ['self', 'ring', 'cascade'] as const) {
    for (const n of [1, 2, 4, 6]) {
      const ls = links(topology, n);
      assert.equal(loopGain(ls, 0), 0, `${topology} ${n}: a loop without feedback`);
      const into = ls.map((l) => l.to);
      assert.equal(new Set(into).size, into.length, 'each tap fed once');
    }
  }
  for (const x of PCM70_PROGRAMS.filter((x) => x.delay)) {
    const s = at(x.num, { decay: 1, depth: 1, delay: 0, size: 0 });
    assert.equal(s.kind, 'taps');
    if (s.kind !== 'taps') continue;
    assert.ok(loopGain(links(s.taps.topology, s.taps.taps.length), s.taps.feedback) < 0.96, x.name);
    // The LFO never sweeps a tap below zero delay.
    for (const t of s.taps.taps) assert.ok(s.taps.depth < t.time, `${x.name} depth`);
  }
});

test('the stereo flange feeds back negatively; chorus programs barely feed back', () => {
  const fl = at('0.3', { decay: 1 });
  assert.ok(fl.kind === 'taps' && fl.taps.feedback < -0.9);
  const ch = at('0.0', { decay: 1 });
  assert.ok(ch.kind === 'taps' && ch.taps.feedback <= 0.6);
});

test('BPM programs: DELAY is the tempo, SIZE the note value, taps land on the beat', () => {
  const s = at('0.8', { delay: 0.4, size: 4 / 6 }); // 120 BPM, quarter notes
  assert.ok(s.kind === 'taps');
  if (s.kind !== 'taps') return;
  assert.equal(s.bpm, 120);
  assert.equal(s.note, '1/4');
  near(s.taps.taps[0].time, 0.5);
  near(s.taps.taps[1].time, 0.75); // the dotted second tap
  const lo = at('1.8', { delay: 0 });
  const hi = at('1.8', { delay: 1 });
  assert.ok(lo.kind === 'taps' && hi.kind === 'taps' && lo.bpm === 40 && hi.bpm === 240);
  // Ping-pong and cascade feed the input only into their first tap.
  for (const n of ['1.8', '6.1']) {
    const c = at(n);
    assert.ok(c.kind === 'taps');
    if (c.kind === 'taps') assert.deepEqual(c.taps.taps.map((t) => t.send).slice(0, 2), [1, 0]);
  }
});

test('SOFT is DIFFUSION in the delay families (bulletin: adds 4–20 ms)', () => {
  const s = at('1.1', { soft: 0.25 });
  assert.ok(s.kind === 'taps' && s.taps.diffusion === 0.25);
  const rate = 48000;
  const [l] = diffusionBurst(rate);
  assert.equal(l.length, Math.floor(0.02 * rate));
  assert.equal(energy(l, 0, Math.floor(0.004 * rate)), 0, 'nothing before 4 ms');
  near(energy(l, 0, l.length), 1, 1e-4);
  // Multiband taps sit in rising bands.
  assert.ok(s.kind === 'taps' && s.taps.taps[0].band < s.taps.taps[1].band);
});

test('reverb knobs: DECAY is RT60, DELAY pre-delay, SOFT the bass multiplier', () => {
  const lo = at('3.0', { decay: 0 });
  const hi = at('3.0', { decay: 1, delay: 1, soft: 1 });
  assert.ok(lo.kind === 'reverb' && hi.kind === 'reverb');
  if (lo.kind !== 'reverb' || hi.kind !== 'reverb') return;
  near(lo.reverb.room.rt, 0.3);
  near(hi.reverb.room.rt, 20);
  near(hi.reverb.predelay, 0.5);
  near(hi.reverb.room.bassMult, 2.5);
  const plate = at('5.0', { decay: 1 });
  assert.ok(plate.kind === 'reverb' && plate.reverb.room.rt === 8);
});

test('room impulses: deterministic, stereo, decaying at RT60, darker as they decay', () => {
  const rate = 16000;
  const room = { shape: 'hall' as const, rt: 1.5, bassMult: 1, trebleHz: 3000, size: 20 };
  const [l, r] = roomImpulse(room, rate);
  const [l2] = roomImpulse(room, rate);
  assert.deepEqual(l, l2);
  assert.equal(l.length, Math.floor(irSeconds(room) * rate));
  near(energy(l, 0, l.length), 0.5, 1e-3);
  // Decorrelated channels
  let c = 0;
  for (let i = 0; i < l.length; i++) c += l[i] * r[i];
  assert.ok(Math.abs(c) / 0.5 < 0.2, `correlation ${c}`);
  // Energy over 0.2 s windows falls by about the RT60 slope (60 dB per 1.5 s → 16 dB per 0.4 s).
  const w = (t: number) => energy(l, Math.floor(t * rate), Math.floor((t + 0.2) * rate));
  const drop = 10 * Math.log10(w(0.3) / w(0.7));
  assert.ok(drop > 12 && drop < 24, `drop ${drop} dB`);
  // High frequencies (first differences) die faster than the rest.
  const hf = (from: number, to: number) => {
    let d = 0;
    for (let i = from + 1; i < to; i++) d += (l[i] - l[i - 1]) ** 2;
    return d / energy(l, from, to);
  };
  assert.ok(hf(Math.floor(1.2 * rate), Math.floor(1.6 * rate)) < hf(1000, 5000));
  near(decayEnv(1.5, 1.5), 0.001, 1e-5);
});

test('the inverse room climbs and stops dead at its length', () => {
  const rate = 16000;
  const room = { shape: 'inverse' as const, rt: 0.4, bassMult: 1, trebleHz: 8000, size: 10 };
  const [l] = roomImpulse(room, rate);
  assert.equal(l.length, Math.floor(0.4 * rate));
  const q = l.length / 4;
  assert.ok(energy(l, 3 * q, 4 * q) > 10 * energy(l, 0, q));
  // …faded out over the last 4 ms rather than cut, so it doesn't click
  const peak = l.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(Math.abs(l[l.length - 1]) < 0.02 * peak);
});

test('resonant chords: combs tuned in tune, folded below the loop limit, ringing for DECAY', () => {
  const rate = 44100;
  for (const ch of CHORDS) {
    const hz = chordHz(36, ch.steps, rate, 4000);
    hz.forEach((f, i) => {
      assert.ok(combDelay(f, 4000) >= minLoopDelay(rate), `${ch.name} ${f}`);
      // Same pitch class as the chord tone, in whole octaves.
      const oct = Math.log2(midiHz(36 + ch.steps[i]) / f);
      near(oct, Math.round(oct), 1e-9);
    });
  }
  const f = 110;
  const g = combFeedback(1 / f, 2);
  near(Math.pow(g, 2 * f), 0.001, 1e-6); // 60 dB down after 2 s of round trips
  assert.ok(lowpassDelay(f, 4000) > 0 && combDelay(f, 4000) < 1 / f);
  const s = at('2.0', { delay: 1 / 3, soft: 0 });
  assert.ok(s.kind === 'chords' && s.chords.root === 36 && s.chords.steps === CHORDS[0].steps);
});

test('the display: program number and name, then the control being changed', () => {
  const base = defaultParams('pcm70');
  for (let i = 0; i < 14; i++) {
    for (const k of ['soft', 'decay', 'delay', 'size', 'treble', 'depth', 'rate', 'mix', 'input']) {
      for (const v of [0, 0.5, 1]) {
        const text = pcm70.display!({ ...base, program: i / 13, [k]: v });
        const lines = text.split('\n');
        assert.ok(text.length <= 24 && lines.every((x) => x.length <= 12), `"${text}"`);
      }
    }
  }
  const a = { ...base, program: prog('1.1') };
  pcm70.display!(a);
  assert.equal(pcm70.display!({ ...a, delay: 0.5 }), '1.1 DBL DLY\nDLY 155MS');
  const tracker = focusTracker('soft');
  const p0 = { x: 0, y: 0, bypass: 0 };
  assert.equal(tracker(p0), 'soft');
  assert.equal(tracker({ ...p0, y: 1 }), 'y');
  assert.equal(tracker({ ...p0, y: 1, bypass: 1 }), 'y', 'bypass keeps the focus');
});
