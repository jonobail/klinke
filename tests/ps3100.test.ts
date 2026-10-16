// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';
import {
  PS_KEYS,
  RES_HIGHPASS,
  RESONATOR_Q,
  filterKeyCents,
  keyFreq,
  keyLevel,
  ps3100Settings,
} from '../src/app/core/ps3100.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) =>
  ps3100Settings({ ...defaultParams('ps3100'), ...over });

test('48 keys, C to B', () => {
  assert.equal(GEAR.ps3100.keyboard?.keys, PS_KEYS);
  assert.equal(PS_KEYS, 48);
});

test('resonator board values from the schematic', () => {
  near(RESONATOR_Q, 5, 1e-9); // 0.082 µF : 820 pF
  assert.ok(RES_HIGHPASS > 55 && RES_HIGHPASS < 61, `${RES_HIGHPASS}`); // ≈58 Hz
});

test('pitch: equal temperament at 8\', SCALE and TEMPERAMENT ADJUST', () => {
  near(keyFreq(69, at({})), 440);
  near(keyFreq(69, at({ scale: 0 })), 220); // 16'
  near(keyFreq(69, at({ scale: 1 })), 880); // 4'
  // A's trimmer fully up: +50 cent on every A, nothing on other notes.
  const s = at({ temper9: 1 });
  near(keyFreq(69, s), 440 * Math.pow(2, 50 / 1200));
  near(keyFreq(57, s), 220 * Math.pow(2, 50 / 1200));
  near(keyFreq(60, s), keyFreq(60, at({})));
});

test('per-key filter follows the key; balance tilts it across the keyboard', () => {
  assert.equal(filterKeyCents(60, 0), 0);
  assert.equal(filterKeyCents(72, 0), 1200);
  assert.equal(filterKeyCents(84, 1), 2400 + 2400);
  assert.equal(filterKeyCents(36, -1), -2400 + 2400);
});

test('keyboard volume balance stays within 0–2', () => {
  assert.equal(keyLevel(60, 0.7), 1);
  assert.ok(keyLevel(84, 1) === 2 && keyLevel(36, 1) === 0);
  assert.ok(keyLevel(100, 1) <= 2 && keyLevel(0, 1) >= 0);
});

test('switches and selectors', () => {
  assert.equal(at({ wave: 0 }).wave, 'saw');
  assert.equal(at({ wave: 1 }).wave, 'pwm');
  assert.equal(at({ release: 0 }).releaseOn, false);
  assert.equal(at({ mg1Wave: 1 }).mg1Wave, 'white');
  assert.equal(at({ kbdTrigger: 1 }).kbdTrigger, 'multi');
  assert.equal(at({ gegDelay: 0 }).gegDelay, 0);
  assert.ok(at({ vp1a: 1, vp1b: 0 }).vp1 > 0 && at({ vp1a: 0, vp1b: 1 }).vp1 < 0);
});
