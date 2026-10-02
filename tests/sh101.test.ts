// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import {
  SEQ_STEPS,
  arpeggio,
  comparatorCurve,
  loadStep,
  pwmBias,
  sh101Settings,
  transposeSequence,
} from '../src/app/core/sh101.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => sh101Settings({ ...defaultParams('sh101'), ...over });

test('ranges follow the specification', () => {
  near(at({ lfoRate: 0 }).lfoRate, 0.1);
  near(at({ lfoRate: 1 }).lfoRate, 30);
  near(at({ cutoff: 0 }).cutoff, 10);
  near(at({ cutoff: 1 }).cutoff, 20000);
  near(at({ attack: 0 }).attack, 0.0015);
  near(at({ attack: 1 }).attack, 4);
  near(at({ decay: 1 }).decay, 10);
  near(at({ release: 0 }).release, 0.002);
  near(at({ tune: 0 }).tuneCents, -50);
  near(at({ pulseWidth: 0 }).pulseWidth, 0.5);
  assert.ok(at({ pulseWidth: 1 }).pulseWidth < 0.05);
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ range: v }).ratio),
    [0.5, 1, 2, 4],
  ); // 16'–2'
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ transpose: v }).transpose),
    [-12, 0, 12],
  ); // L M H
  assert.equal(at({ portaTime: 0 }).portaTime, 0);
});

test('switches: LFO wave, sub oscillator, PWM source, envelope trigger, arpeggio, sequencer', () => {
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ lfoWave: v }).lfoWave),
    ['triangle', 'square', 'random', 'noise'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ subMode: v }).subMode),
    ['oct1', 'oct2', 'pulse2'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ pwmSource: v }).pwmSource),
    ['lfo', 'man', 'env'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ envTrigger: v }).envTrigger),
    ['gateTrig', 'gate', 'lfo'],
  );
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ arp: v }).arp),
    ['off', 'up', 'updown', 'down'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ seq: v }).seq),
    ['off', 'load', 'play'],
  );
});

test('PWM: bias for a duty cycle, and the comparator squares the saw', () => {
  near(pwmBias(0.5), 0);
  near(pwmBias(0.25), -0.5);
  const c = comparatorCurve(1001);
  near(c[500], 0);
  assert.ok(c[0] < -0.99 && c[1000] > 0.99);
  // A rising saw plus bias: the fraction of a cycle above zero is the duty cycle.
  for (const duty of [0.5, 0.25, 0.1]) {
    const n = 1000;
    let high = 0;
    for (let i = 0; i < n; i++) if ((2 * i) / n - 1 + pwmBias(duty) > 0) high++;
    near(high / n, duty, 0.002);
  }
});

test('arpeggio orders: up, down, up & down without doubled ends', () => {
  const held = [64, 60, 67, 60];
  assert.deepEqual(arpeggio(held, 'up'), [60, 64, 67]);
  assert.deepEqual(arpeggio(held, 'down'), [67, 64, 60]);
  assert.deepEqual(arpeggio([60, 64, 67, 72], 'updown'), [60, 64, 67, 72, 67, 64]);
  assert.deepEqual(arpeggio([60, 64], 'updown'), [60, 64]);
  assert.deepEqual(arpeggio(held, 'off'), []);
});

test('sequencer: 100 steps, rests, transpose by the held key', () => {
  let s: (number | null)[] = [];
  s = loadStep(s, 60);
  s = loadStep(s, null);
  s = loadStep(s, 63);
  assert.deepEqual(s, [60, null, 63]);
  const full = Array.from({ length: SEQ_STEPS }, () => 60);
  assert.equal(loadStep(full, 61).length, SEQ_STEPS);
  assert.deepEqual(transposeSequence(s, 65), [65, null, 68]);
  assert.deepEqual(transposeSequence(s, null), s);
  assert.deepEqual(transposeSequence([null], 65), [null]);
});
