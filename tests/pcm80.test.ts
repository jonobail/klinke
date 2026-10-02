// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { CHORDS, NOTE_VALUES, links, loopGain } from '../src/app/core/devices/pcm-dsp.ts';
import {
  PCM80_ALGORITHMS,
  pcm80,
  pcm80Settings,
  pcm80Unit,
} from '../src/app/core/devices/pcm80.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const n = PCM80_ALGORITHMS.length;
const at = (algo: number, over: Record<string, number> = {}) =>
  pcm80Settings({ ...defaultParams('pcm80'), algo: algo / (n - 1), ...over });

test('algorithms: Concert Hall first (service manual p. 3-7), all distinct engines', () => {
  assert.equal(n, 8);
  assert.equal(PCM80_ALGORITHMS[0].short, 'ConcertHall');
  assert.equal(pcm80Settings(defaultParams('pcm80')).algo, 0);
  const kinds = PCM80_ALGORITHMS.map((_, i) => at(i).kind);
  for (const k of ['reverb', 'chorusVerb', 'taps', 'chords'])
    assert.ok(kinds.includes(k as never), k);
});

test('TEMPO × NOTE sets the delay step', () => {
  const p = { ...defaultParams('pcm80'), tempo: 0.4, div: 4 / 6 };
  near(pcm80Unit(p), 0.5); // 120 BPM quarter notes
  near(pcm80Unit({ ...p, div: 2 / 6 }), 0.25); // eighths
  near(pcm80Unit({ ...p, tempo: 0, div: 0 }), (60 / 40) * NOTE_VALUES[0].beats);
});

test('Concert Hall: ADJUST brings up echoes on the tempo step ("UpMyEchos")', () => {
  const s = at(0, { adjust: 0.8, tempo: 0.4, div: 4 / 6 });
  assert.ok(s.kind === 'reverb' && s.reverb.echo);
  if (s.kind !== 'reverb') return;
  near(s.reverb.echo!.level, 0.8);
  near(s.reverb.echo!.time, 0.5);
  assert.ok(s.reverb.echo!.feedback < 1);
  near(s.reverb.room.rt, 0.3 * Math.pow(20 / 0.3, 0.5));
});

test('Plate: BLOOM lengthens the decay and opens the top', () => {
  const lo = at(1, { adjust: 0 });
  const hi = at(1, { adjust: 1 });
  assert.ok(lo.kind === 'reverb' && hi.kind === 'reverb');
  if (lo.kind !== 'reverb' || hi.kind !== 'reverb') return;
  assert.ok(hi.reverb.room.rt > 2.5 * lo.reverb.room.rt);
  assert.ok(hi.reverb.room.trebleHz > lo.reverb.room.trebleHz);
  assert.equal(hi.reverb.room.shape, 'plate');
});

test('every tap algorithm stays bounded and never sweeps below zero delay', () => {
  for (let i = 0; i < n; i++) {
    for (const over of [{ decay: 1, depth: 1, adjust: 1, size: 0, tempo: 1, div: 0 }, {}]) {
      const s = at(i, over);
      if (s.kind !== 'taps' && s.kind !== 'chorusVerb') continue;
      const t = s.taps;
      assert.ok(loopGain(links(t.topology, t.taps.length), t.feedback) < 0.96, `${i}`);
      for (const tap of t.taps) assert.ok(t.depth < tap.time, `${i} depth`);
    }
  }
});

test('Dual Delay: left on the step, right later by SIZE, bouncing; WIDTH spreads them', () => {
  const s = at(6, { size: 0.5, adjust: 1, tempo: 0.4, div: 4 / 6 });
  assert.ok(s.kind === 'taps');
  if (s.kind !== 'taps') return;
  near(s.taps.taps[0].time, 0.5);
  near(s.taps.taps[1].time, 0.75);
  assert.deepEqual(
    s.taps.taps.map((t) => t.send),
    [1, 0],
  );
  assert.equal(s.taps.topology, 'ring');
  assert.deepEqual(
    s.taps.taps.map((t) => t.pan),
    [-1, 1],
  );
});

test('Multi-band: six taps on the step grid in rising bands; BANDS narrows them', () => {
  const lo = at(5, { adjust: 0, size: 1, tempo: 0.4, div: 4 / 6 });
  const hi = at(5, { adjust: 1 });
  assert.ok(lo.kind === 'taps' && hi.kind === 'taps');
  if (lo.kind !== 'taps' || hi.kind !== 'taps') return;
  assert.equal(lo.taps.taps.length, 6);
  lo.taps.taps.forEach((t, i) => near(t.time, 0.5 * (1 + i)));
  for (let i = 1; i < 6; i++) assert.ok(lo.taps.taps[i].band > lo.taps.taps[i - 1].band);
  assert.ok(hi.taps.bandQ! > lo.taps.bandQ!);
});

test('Res-Chord: SIZE is the root, ADJUST the chord', () => {
  const s = at(7, { size: 1 / 3, adjust: 1 });
  assert.ok(s.kind === 'chords');
  if (s.kind !== 'chords') return;
  assert.equal(s.chords.root, 36);
  assert.equal(s.chords.steps, CHORDS.at(-1)!.steps);
});

test('the display: algorithm, then the control being changed, as the soft knob shows it', () => {
  const base = defaultParams('pcm80');
  for (let i = 0; i < n; i++) {
    for (const k of ['adjust', 'tempo', 'div', 'decay', 'size', 'tone', 'depth', 'rate', 'mix']) {
      for (const v of [0, 0.5, 1]) {
        const text = pcm80.display!({ ...base, algo: i / (n - 1), [k]: v });
        const lines = text.split('\n');
        assert.ok(text.length <= 24 && lines.every((x) => x.length <= 12), `"${text}"`);
      }
    }
  }
  const a = { ...base };
  pcm80.display!(a);
  assert.equal(pcm80.display!({ ...a, adjust: 0.64 }), 'ConcertHall\n*ECHOES 64%');
  assert.equal(pcm80.display!({ ...a, adjust: 0.64, tempo: 0.5 }), 'ConcertHall\n140BPM 1/4');
});
