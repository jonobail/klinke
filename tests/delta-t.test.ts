// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import {
  CLOCK_MODES,
  STEPS,
  VCO_MIN_MHZ,
  XTAL_MHZ,
  deltaT,
  deltaTSettings,
  gainRange,
  quantise,
  quantiseCurve,
  tapSeconds,
  tapStep,
} from '../src/app/core/devices/delta-t.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const mode = (m: (typeof CLOCK_MODES)[number]) => CLOCK_MODES.indexOf(m) / (CLOCK_MODES.length - 1);
const at = (over: Record<string, number>) =>
  deltaTSettings({ ...defaultParams('deltaT'), ...over });

test('taps sit every 3 ms, 3–192 ms over the 64 switch positions (DM-102-S, OM-102)', () => {
  assert.equal(tapStep(0), 1);
  assert.equal(tapStep(1), STEPS);
  near(tapSeconds(1), 0.003);
  near(tapSeconds(8), 0.024); // end of "data out A, 3–24 ms"
  near(tapSeconds(16), 0.048); // end of "data out B, 27–48 ms"
  near(tapSeconds(STEPS), 0.192);
  for (let i = 0; i < STEPS; i++) assert.equal(tapStep((i + 0.5) / STEPS), i + 1);
});

test('the VCO clock scales every tap together, up to ×2 at 2.21 MHz', () => {
  const x = at({ clock: mode('XTAL'), d1: 1 });
  near(x.taps[0], 0.192);
  const slow = at({ clock: mode('MANUAL'), offset: 0, d1: 1 });
  near(slow.mhz, VCO_MIN_MHZ);
  near(slow.taps[0], 0.192 * (XTAL_MHZ / VCO_MIN_MHZ));
  assert.ok(slow.taps[0] < 0.45);
  const fast = at({ clock: mode('MANUAL'), offset: 1 });
  assert.ok(fast.taps[0] < slow.taps[0]);
  near(fast.taps[1] / fast.taps[0], 2);
  assert.equal(x.modFraction, 0);
  assert.equal(at({ clock: mode('MANUAL') }).modFraction, 0);
});

test('VCO sweep stays within the clock range and never reverses a tap', () => {
  for (const m of ['SINE', 'TRI', 'SQUARE'] as const) {
    for (const rate of [0, 0.5, 1]) {
      const s = at({ clock: mode(m), depth: 1, rate, offset: 0.5, d1: 1, d2: 1, d3: 1 });
      assert.ok(s.modFraction > 0, m);
      const longest = Math.max(...s.taps);
      const a = s.modFraction * longest;
      const slope = (m === 'SINE' ? 2 * Math.PI : 4) * a * s.rateHz;
      if (m !== 'SQUARE') assert.ok(slope <= 0.9 + 1e-9, `${m} ${rate}`);
      else assert.ok(s.modFraction <= 0.25 && s.smoothingHz < 10);
    }
  }
  // At the bottom of the VCO range there's no room to swing further down.
  assert.equal(at({ clock: mode('SINE'), depth: 1, offset: 0 }).modFraction, 0);
  near(at({ rate: 0 }).rateHz, 0.2);
  near(at({ rate: 1 }).rateHz, 20);
});

test('gain ranging: 0 / 10 / 20 / 30 dB, finer steps for quieter signals', () => {
  near(gainRange(0.9), 1);
  near(gainRange(0.2), Math.sqrt(10));
  near(gainRange(0.05), 10);
  near(gainRange(0.001), Math.pow(10, 1.5));
  // Error is at most half a step of the active range.
  for (const x of [0.9, 0.2, 0.05, 0.001, -0.37]) {
    const step = 2 / 4096 / gainRange(x);
    assert.ok(Math.abs(quantise(x) - x) <= step / 2 + 1e-12, String(x));
  }
  assert.equal(quantise(1.7), 1);
  assert.equal(quantise(-3), -1);
  const c = quantiseCurve(4097);
  assert.equal(c.length, 4097);
  near(c[2048], 0);
});

test('regen stays below unity; display fits', () => {
  assert.ok(at({ regen: 1 }).regen < 1);
  const text = deltaT.display!({
    ...defaultParams('deltaT'),
    d1: 1,
    d2: 1,
    d3: 1,
    clock: mode('SQUARE'),
    offset: 0,
  });
  assert.ok(text.length <= 24, text);
  assert.equal(deltaT.display!(defaultParams('deltaT')), '96 192 144\nXTAL 4.437');
});
