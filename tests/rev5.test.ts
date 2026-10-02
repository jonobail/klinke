// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { energy, measureRt } from '../src/app/core/devices/reverb-ir.ts';
import {
  EQ_RANGES,
  REV5_PROGRAMS,
  rev5,
  rev5EarlyTaps,
  rev5Impulse,
  rev5Settings,
} from '../src/app/core/devices/rev5.ts';

const RATE = 8000;
const prog = (key: string) =>
  REV5_PROGRAMS.findIndex((x) => x.key === key) / (REV5_PROGRAMS.length - 1);
const at = (over: Record<string, number>) => rev5Settings({ ...defaultParams('rev5'), ...over });
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('the seven direct-recall keys (p. 3)', () => {
  assert.deepEqual(
    REV5_PROGRAMS.map((x) => x.key),
    ['REV1', 'REV2', 'REV3', 'REV4', 'E/R1', 'E/R2', 'OTHERS'],
  );
});

test('the analog EQ spans the specified ranges, ±15 dB, and only with EQ ON', () => {
  near(at({ loFreq: 0 }).lo.hz, EQ_RANGES.lo[0]);
  near(at({ loFreq: 1 }).lo.hz, 700);
  near(at({ midFreq: 0 }).mid.hz, 350);
  near(at({ midFreq: 1 }).mid.hz, 5000);
  near(at({ hiFreq: 0 }).hi.hz, 2000);
  near(at({ hiFreq: 1 }).hi.hz, 20000);
  near(at({ loLevel: 0 }).lo.db, -15);
  near(at({ hiLevel: 1 }).hi.db, 15);
  near(at({ midLevel: 0.5 }).mid.db, 0);
  assert.equal(at({}).eqOn, false);
});

test('the reverb decays over RT, and longer for longer settings', () => {
  const short = at({ program: prog('REV2'), rt: 0.05, high: 1 });
  const long = at({ program: prog('REV2'), rt: 0.2, high: 1 });
  const a = measureRt(rev5Impulse(short, RATE)[0], RATE);
  const b = measureRt(rev5Impulse(long, RATE)[0], RATE);
  assert.ok(Math.abs(a - short.rt) / short.rt < 0.3, `${a} vs ${short.rt}`);
  assert.ok(b > a * 1.3);
});

test('E/R programs are reflections only; the gate program stops at its gate time', () => {
  const er = at({ program: prog('E/R1') });
  assert.ok(rev5EarlyTaps(er).length > 10);
  assert.ok(rev5Impulse(er, RATE)[0].length / RATE < 0.6);
  const g = at({ program: prog('OTHERS'), rt: 0.5 });
  const [l] = rev5Impulse(g, RATE);
  const end = g.initDelay + g.prog.erSpan * 0.6 + g.rt;
  assert.ok(energy(l, RATE, 0, end) > 0);
  assert.equal(energy(l, RATE, end + 0.01), 0);
});

test('the plate has no early reflections and fills in faster than the hall', () => {
  const plate = at({ program: prog('REV4') });
  assert.equal(rev5EarlyTaps(plate).length, 0);
  const hall = at({ program: prog('REV1') });
  assert.ok(plate.prog.density < hall.prog.density);
});

test('1ST REF sets the reflections; INITIAL DELAY moves them', () => {
  assert.equal(rev5EarlyTaps(at({ firstRef: 0 })).length, 0);
  const a = rev5EarlyTaps(at({ initDelay: 0 }))[0].t;
  const b = rev5EarlyTaps(at({ initDelay: 1 }))[0].t;
  near(b - a, 0.3999, 1e-6);
});

test('the display fits every program', () => {
  for (let i = 0; i < REV5_PROGRAMS.length; i++) {
    for (const v of [0, 1]) {
      const text = rev5.display!({
        ...defaultParams('rev5'),
        program: i / (REV5_PROGRAMS.length - 1),
        rt: v,
        initDelay: v,
      });
      assert.ok(text.length <= 24, text);
    }
  }
});
