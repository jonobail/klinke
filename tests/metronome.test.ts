// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_REC_OPTIONS,
  accented,
  clickPitch,
  earlier,
  parseRecOptions,
  recLatency,
  secondsToBeats,
} from '../src/app/core/metronome.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('options load with defaults for anything missing or damaged', () => {
  assert.deepEqual(parseRecOptions(null), DEFAULT_REC_OPTIONS);
  assert.deepEqual(
    parseRecOptions({ click: true, countIn: 2, autoLatency: false, offsetMs: 12.4 }),
    {
      click: true,
      countIn: 2,
      autoLatency: false,
      offsetMs: 12,
    },
  );
  assert.equal(parseRecOptions({ countIn: 7 }).countIn, 1);
  assert.equal(parseRecOptions({ countIn: 0 }).countIn, 0);
  assert.equal(parseRecOptions({ offsetMs: 9999 }).offsetMs, 250);
  assert.equal(parseRecOptions({ offsetMs: 'x' }).offsetMs, 0);
});

test('latency: output latency when auto, plus the offset, never below zero', () => {
  near(recLatency(DEFAULT_REC_OPTIONS, 0.02), 0.02);
  near(recLatency({ ...DEFAULT_REC_OPTIONS, offsetMs: 10 }, 0.02), 0.03);
  near(recLatency({ ...DEFAULT_REC_OPTIONS, autoLatency: false, offsetMs: 10 }, 0.02), 0.01);
  near(recLatency({ ...DEFAULT_REC_OPTIONS, offsetMs: -100 }, 0.02), 0);
  near(recLatency(DEFAULT_REC_OPTIONS, NaN), 0);
});

test('moving a position earlier stays inside the loop', () => {
  near(secondsToBeats(0.5, 120), 1);
  near(earlier(4.1, 0.05, 16), 4.05);
  near(earlier(0.02, 0.05, 16), 15.97);
});

test('the downbeat click is accented and higher', () => {
  assert.equal(accented(0), true);
  assert.equal(accented(4), true);
  assert.equal(accented(-4), true);
  assert.equal(accented(1), false);
  assert.equal(accented(-1), false);
  assert.ok(clickPitch(0) > clickPitch(2));
});
