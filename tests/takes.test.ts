// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_TAKE,
  moveTake,
  recordedLength,
  trimTakeEnd,
  trimTakeStart,
  visiblePeaks,
} from '../src/app/core/takes.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
// 120 BPM: half a second a beat. A 2 s take (4 beats) at beat 8.
const spb = 0.5;
const take = { id: 'k', start: 8, duration: 2, peaks: new Array(100).fill(0.5) };

test('moving a take keeps it inside the loop', () => {
  assert.equal(moveTake(take, 10, 64, spb).start, 10);
  assert.equal(moveTake(take, -3, 64, spb).start, 0);
  assert.equal(moveTake(take, 62, 64, spb).start, 60);
  assert.equal(moveTake(take, 10, 64, spb).duration, 2);
});

test('trimming the start moves the offset with it, and pulls back out', () => {
  const t = trimTakeStart(take, 9, spb);
  near(t.start, 9);
  near(t.offset!, 0.5);
  near(t.duration, 1.5);
  // Pulled back out: no further than the top of the recording.
  const back = trimTakeStart(t, 5, spb);
  near(back.start, 8);
  near(back.offset!, 0);
  near(back.duration, 2);
  // Never shorter than MIN_TAKE.
  const tiny = trimTakeStart(take, 20, spb);
  near(tiny.duration, MIN_TAKE);
});

test('trimming the end stops at the recording and the loop', () => {
  const t = trimTakeEnd(take, 10, 2, 64, spb);
  near(t.duration, 1);
  near(trimTakeEnd(t, 30, 2, 64, spb).duration, 2);
  // A loop ending at beat 11 cuts it there.
  near(trimTakeEnd(take, 30, 2, 11, spb).duration, 1.5);
  near(trimTakeEnd(take, 0, 2, 64, spb).duration, MIN_TAKE);
});

test('the recorded length and the waveform slice that plays', () => {
  assert.equal(recordedLength(take), 2);
  const t = trimTakeStart(trimTakeEnd(take, 11, 2, 64, spb), 9, spb);
  assert.deepEqual(visiblePeaks(t), [25, 75]);
  assert.equal(recordedLength(t), 2);
});
