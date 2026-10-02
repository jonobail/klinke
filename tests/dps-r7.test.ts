// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { energy, measureRt } from '../src/app/core/devices/reverb-ir.ts';
import {
  DPS_R7_ALGORITHMS,
  dpsR7,
  dpsR7EarlyTaps,
  dpsR7Impulse,
  dpsR7Settings,
  words,
} from '../src/app/core/devices/dps-r7.ts';

const RATE = 8000;
const algo = (code: string) =>
  DPS_R7_ALGORITHMS.findIndex((a) => a.code === code) / (DPS_R7_ALGORITHMS.length - 1);
const at = (over: Record<string, number>) => dpsR7Settings({ ...defaultParams('dpsR7'), ...over });
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('the five ST-ST REVS algorithms (pp. 24–28)', () => {
  assert.deepEqual(
    DPS_R7_ALGORITHMS.map((a) => a.code),
    ['HLR', 'RMR', 'PLR', 'GTR', 'ERF'],
  );
});

test('reverb time and predelay ranges come from the parameter tables', () => {
  near(at({ algo: algo('HLR'), time: 0 }).time, 0.3);
  near(at({ algo: algo('HLR'), time: 1 }).time, 99);
  near(at({ algo: algo('RMR'), time: 0 }).time, 0.12);
  near(at({ algo: algo('RMR'), time: 1 }).time, 39.6);
  assert.equal(at({ predelay: 1 }).predelayWords, 32767);
  assert.equal(at({ algo: algo('PLR'), predelay: 1 }).predelayWords, 22527);
  assert.equal(at({ predelay: 0 }).predelayWords, 1);
  // 32767 words at 40 kHz is about 0.82 s.
  near(words(32767), 0.819, 0.001);
  near(at({ algo: algo('GTR'), time: 1 }).time, words(16383));
  near(at({ algo: algo('RMR'), spread: 1 }).spread, 2.5);
  near(at({ bassLevel: 0 }).bassDb, -12);
  near(at({ bassLevel: 1 }).bassDb, 6);
  near(at({ bassLevel: 0.5 }).bassDb, 0);
  near(at({ algo: algo('PLR'), bassLevel: 0 }).bassDb, 0);
});

test('the hall decays over its reverb time, and longer for longer settings', () => {
  const short = at({ time: 0.05, rotateHigh: 1, bassLevel: 0.5 });
  const long = at({ time: 0.15, rotateHigh: 1, bassLevel: 0.5 });
  const a = measureRt(dpsR7Impulse(short, RATE)[0], RATE);
  const b = measureRt(dpsR7Impulse(long, RATE)[0], RATE);
  assert.ok(Math.abs(a - short.time) / short.time < 0.25, `${a} vs ${short.time}`);
  assert.ok(b > a * 1.3, `${b} vs ${a}`);
});

test('the gate holds for the gate time and stops; reverse swells instead', () => {
  const s = at({ algo: algo('GTR'), time: 0.8, predelay: 0, size: 0.25, envForm: 1 });
  const [l] = dpsR7Impulse(s, RATE);
  const gate = s.time * Math.min(1, s.size);
  assert.equal(energy(l, RATE, gate + 0.01), 0);
  const fwd = energy(l, RATE, 0, gate / 3) / energy(l, RATE, (2 * gate) / 3, gate);
  const [r] = dpsR7Impulse({ ...s, reverse: true }, RATE);
  const rev = energy(r, RATE, 0, gate / 3) / energy(r, RATE, (2 * gate) / 3, gate);
  assert.ok(fwd > 1.5 && rev < 0.7, `${fwd} ${rev}`);
});

test('ERF is 48 taps per channel and no tail', () => {
  const s = at({ algo: algo('ERF') });
  const taps = dpsR7EarlyTaps(s);
  assert.equal(taps.filter((t) => t.ch === 0).length, 48);
  assert.equal(taps.filter((t) => t.ch === 1).length, 48);
  const [l] = dpsR7Impulse(s, RATE);
  assert.ok(l.length / RATE < 0.5);
});

test('E.REF scales the early reflections; SPREAD decorrelates the channels', () => {
  assert.equal(dpsR7EarlyTaps(at({ er: 0 })).length, 0);
  const corr = (spread: number) => {
    const [l, r] = dpsR7Impulse(at({ spread, er: 0, time: 0.1 }), RATE);
    let lr = 0;
    for (let i = 0; i < l.length; i++) lr += l[i] * r[i];
    return lr / Math.sqrt(energy(l, RATE) * energy(r, RATE));
  };
  assert.ok(corr(0) > corr(1) + 0.3, `${corr(0)} ${corr(1)}`);
});

test('the display fits every algorithm at its extremes', () => {
  for (let i = 0; i < DPS_R7_ALGORITHMS.length; i++) {
    for (const v of [0, 1]) {
      const text = dpsR7.display!({
        ...defaultParams('dpsR7'),
        algo: i / (DPS_R7_ALGORITHMS.length - 1),
        time: v,
        predelay: v,
      });
      assert.ok(text.length <= 24, text);
    }
  }
});
