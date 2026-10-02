// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { energy, measureRt } from '../src/app/core/devices/reverb-ir.ts';
import {
  MODEL200_PROGRAMS,
  model200,
  model200Impulse,
  model200PreEchoes,
  model200Settings,
  variation,
} from '../src/app/core/devices/model200.ts';

const RATE = 8000;
const at = (over: Record<string, number>) =>
  model200Settings({ ...defaultParams('model200'), ...over });
const prog = (n: number) => (n - 1) / (MODEL200_PROGRAMS.length - 1);
const varPos = (v: number) => v / 9;

test('six programs; program 1 is the halls with 23 ms of built-in predelay', () => {
  assert.equal(MODEL200_PROGRAMS.length, 6);
  assert.equal(at({ program: 0, predelay: 0 }).predelay, 0.023);
  assert.equal(at({ program: prog(2), predelay: 0 }).predelay, 0);
});

test('ranges follow the specifications (p. 1-2)', () => {
  // Size: maximum 40–99 m, program-dependent.
  const maxes = MODEL200_PROGRAMS.map((_, i) => at({ program: prog(i + 1), size: 1 }).size);
  assert.equal(Math.max(...maxes), 99);
  assert.equal(Math.min(...maxes), 40);
  // Predelay ceiling 39–999 ms, size-dependent.
  assert.ok(Math.abs(at({ program: 0, size: 1, predelay: 1 }).predelay - 0.999) < 1e-9);
  assert.ok(Math.abs(at({ program: prog(2), size: 0, predelay: 1 }).predelay - 0.039) < 1e-9);
  // Reverb time about 0.6–70 s.
  assert.equal(at({ program: 0, size: 1, rt: 1 }).rt, 70);
  assert.equal(at({ program: 0, size: 0, rt: 0 }).rt, 0.6);
});

test('SIZE changes the reverb time, except in the Inverse Room', () => {
  assert.ok(at({ size: 1 }).rt > at({ size: 0.3 }).rt);
  const inv = prog(5);
  assert.equal(at({ program: inv, size: 1 }).rt, at({ program: inv, size: 0.2 }).rt);
});

test('the variation keypad: rows are sizes, columns RT and pre-echoes (Addendum p. 4)', () => {
  assert.deepEqual(
    [1, 4, 7].map((v) => variation(v).preEcho),
    [0, 0, 0],
  );
  assert.deepEqual(
    [2, 5, 8].map((v) => variation(v).preEcho),
    [0.5, 0.5, 0.5],
  );
  assert.deepEqual(
    [3, 6, 9].map((v) => variation(v).preEcho),
    [1, 1, 1],
  );
  assert.ok(variation(3).rtScale < variation(1).rtScale);
  assert.ok(
    variation(7).spacing < variation(4).spacing && variation(4).spacing < variation(1).spacing,
  );
  assert.ok(variation(0).metallic && !variation(1).metallic);
  assert.equal(
    model200Settings({ ...defaultParams('model200'), variation: varPos(0) }).modDepth,
    0,
  );
});

test('pre-echoes need the switch and a variation that has them; they may beat the predelay', () => {
  assert.equal(model200PreEchoes(at({ preEchoes: 1, variation: varPos(1) })).length, 0);
  assert.equal(model200PreEchoes(at({ preEchoes: 0, variation: varPos(3) })).length, 0);
  const s = at({ preEchoes: 1, variation: varPos(3), predelay: 1 });
  const taps = model200PreEchoes(s);
  assert.ok(taps.length > 0 && taps[0].t < s.predelay);
});

test('the impulse decays over the set reverb time', () => {
  for (const rt of [0.2, 0.5]) {
    const s = at({ rt, contourLow: 0.5, contourHigh: 0, rolloff: 1 });
    const [l] = model200Impulse(s, RATE);
    const measured = measureRt(l, RATE);
    assert.ok(Math.abs(measured - s.rt) / s.rt < 0.25, `rt ${s.rt} measured ${measured}`);
  }
});

test('the impulse is deterministic, starts at the predelay, and programs differ', () => {
  const s = at({ predelay: 0.5 });
  const a = model200Impulse(s, RATE)[0];
  const b = model200Impulse(s, RATE)[0];
  assert.deepEqual(a, b);
  assert.equal(energy(a, RATE, 0, s.predelay - 0.001), 0);
  const plate = model200Impulse(at({ program: prog(2) }), RATE)[0];
  assert.notDeepEqual(plate.slice(0, 800), a.slice(0, 800));
});

test('the Inverse Room swells, then stops', () => {
  const s = at({ program: prog(5), predelay: 0 });
  const [l] = model200Impulse(s, RATE);
  const third = s.rt / 3;
  assert.ok(energy(l, RATE, 2 * third, 3 * third) > 3 * energy(l, RATE, 0, third));
  assert.equal(energy(l, RATE, s.rt + 0.02), 0);
});

test('ROLLOFF LOW takes off top end', () => {
  const rate = 32000;
  const hf = (d: Float32Array) => {
    let s = 0;
    for (let i = 1; i < d.length; i++) s += (d[i] - d[i - 1]) ** 2;
    return s / energy(d, rate);
  };
  const low = model200Impulse(at({ rolloff: 0, rt: 0.2 }), rate)[0];
  const high = model200Impulse(at({ rolloff: 1, rt: 0.2 }), rate)[0];
  assert.ok(hf(low) < 0.7 * hf(high));
});

test('the display fits every program at its extremes', () => {
  for (let i = 0; i < 6; i++) {
    for (const v of [0, 1]) {
      const text = model200.display!({
        ...defaultParams('model200'),
        program: prog(i + 1),
        rt: v,
        size: v,
        predelay: v,
      });
      assert.ok(text.length <= 24, text);
    }
  }
});
