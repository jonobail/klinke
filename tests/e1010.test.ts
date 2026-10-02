// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { maxModDepth, qDb } from '../src/app/core/devices/filter-math.ts';
import {
  CLOCK_LONG,
  CLOCK_SHORT,
  PASSIVE_C,
  PASSIVE_R,
  RANGES,
  STAGES,
  bbdDelay,
  e1010,
  e1010Settings,
  rcLadder,
  rcLadderDb,
} from '../src/app/core/devices/e1010.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => e1010Settings({ ...defaultParams('e1010'), ...over });
const range = (i: number) => i / (RANGES.length - 1);

test('each range tap reaches its nominal delay at the slow clock (Table-3, p. 3)', () => {
  // Table-3: 9.3 ms (+10 %) on the 10 ms range, the nominal value on the others.
  near(bbdDelay(STAGES[0], CLOCK_LONG), 0.00938, 1e-4);
  for (let i = 1; i < RANGES.length; i++)
    near(bbdDelay(STAGES[i], CLOCK_LONG), RANGES[i] / 1000, 1e-3);
  for (let i = 0; i < RANGES.length; i++)
    near(at({ range: range(i), delay: 1 }).seconds, bbdDelay(STAGES[i], CLOCK_LONG));
});

test('DELAY SHORT is a third of LONG (12.2 µs vs 36.6 µs clock); 300 ms range ≤ 130 ms short', () => {
  near(CLOCK_SHORT / CLOCK_LONG, 3, 0.01);
  const short = at({ range: 1, delay: 0 }).seconds;
  assert.ok(short <= 0.13 && short >= 0.09, String(short));
  near(at({ range: range(0), delay: 0 }).seconds, 0.0031, 1e-4); // spec: 3–10 ms
  assert.ok(at({ delay: 0.2 }).seconds < at({ delay: 0.8 }).seconds);
});

test('the passive delay output filter matches Table-1 at 3 kHz', () => {
  // Table-1 (3 kHz, re 700 Hz): 150 ms −2.5 ±2 dB, 225 ms −3.1 ±2, 300 ms −4.0 ±2.
  const db = (i: number) => {
    const c = PASSIVE_C[i]!;
    return rcLadderDb(PASSIVE_R, c[0], c[1], 3000) - rcLadderDb(PASSIVE_R, c[0], c[1], 700);
  };
  assert.ok(Math.abs(db(2) - -2.5) < 1, String(db(2)));
  assert.ok(Math.abs(db(3) - -3.1) < 1, String(db(3)));
  assert.ok(Math.abs(db(4) - -4.0) < 2, String(db(4)));
  assert.equal(at({ range: range(0) }).outFilter, null);
  // The biquad form has the same response as the ladder.
  const { hz, q } = rcLadder(PASSIVE_R, 0.018e-6, 0.01e-6);
  const w = 3000 / hz;
  const biquadDb = -20 * Math.log10(Math.hypot(1 - w * w, w / q));
  near(biquadDb, rcLadderDb(PASSIVE_R, 0.018e-6, 0.01e-6, 3000), 1e-6);
});

test('modulation: 0.5–10 Hz, depth up to 10 % (10 ms) / 30 % (300 ms), never reversing', () => {
  near(at({ rate: 0 }).rateHz, 0.5);
  near(at({ rate: 1 }).rateHz, 10);
  const s = at({ range: range(0), delay: 1, depth: 1, rate: 0 });
  near(2 * s.modDepth, 0.1 * s.seconds);
  for (const r of [0, 0.5, 1]) {
    const m = at({ range: 1, delay: 1, depth: 1, rate: r });
    assert.ok(4 * m.modDepth * m.rateHz <= 0.9 + 1e-9, `slope at rate ${r}`);
    assert.ok(m.modDepth <= (0.3 * m.seconds) / 2 + 1e-12);
  }
  assert.equal(at({ depth: 0 }).modDepth, 0);
  assert.equal(maxModDepth(0, 'sine'), Infinity);
});

test('tone ±12 dB, feedback just past unity, Butterworth Q in dB', () => {
  near(at({ bass: 0 }).bassDb, -12);
  near(at({ treble: 1 }).trebleDb, 12);
  near(at({ bass: 0.5 }).bassDb, 0);
  assert.ok(at({ feedback: 1 }).feedback > 1 && at({ feedback: 0.9 }).feedback < 1);
  near(qDb(Math.SQRT1_2), -3.0103, 1e-3);
});

test('display shows the delay and the range', () => {
  assert.equal(e1010.display!(defaultParams('e1010')), '86.6 MS\nRANGE 150');
});
