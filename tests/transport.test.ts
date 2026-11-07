// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SONG_BEATS,
  beatsAfter,
  clampBpm,
  clampLoop,
  clampWindow,
  formatPosition,
  loopRepeats,
  trackLoopBeats,
  wrapBeat,
} from '../src/app/core/transport.ts';

test('position counter reads bar.beat.sixteenth', () => {
  assert.equal(formatPosition(0), '001.1.1');
  assert.equal(formatPosition(0.25), '001.1.2');
  assert.equal(formatPosition(5 * 4 + 2), '006.3.1');
  assert.equal(formatPosition(SONG_BEATS - 0.01), '016.4.4');
});

test('beats advance with tempo and wrap at the song loop', () => {
  assert.equal(beatsAfter(0, 1, 120), 2);
  assert.equal(beatsAfter(SONG_BEATS - 1, 1, 120), 1);
});

test('BPM stays in range at 0.1 resolution', () => {
  assert.equal(clampBpm(10), 40);
  assert.equal(clampBpm(999), 300);
  assert.equal(clampBpm(120.04), 120);
});

test('song and track loops', () => {
  assert.equal(beatsAfter(15, 1, 120, 16), 1); // a 4-bar song loop wraps at beat 16
  assert.equal(trackLoopBeats(0, 32), 32); // no track loop: follows the song
  assert.equal(trackLoopBeats(2, 32), 8);
  assert.equal(trackLoopBeats(16, 32), 32); // longer than the song loop: the song wins
  assert.deepEqual(loopRepeats(8, 32), [0, 8, 16, 24]);
  assert.deepEqual(loopRepeats(64, 16), [0]);
  assert.equal(clampLoop(4, false), 4);
  assert.equal(clampLoop(3, false), 3); // any whole number of bars
  assert.equal(clampLoop(2.6, false), 3);
  assert.equal(clampLoop(40, false), 16);
  assert.equal(clampLoop('x', false), 16);
  assert.equal(clampLoop(0, true), 0);
  assert.equal(clampLoop('x', true), 0);
});

test('the song loop is a window: past its end the song comes round to its start', () => {
  assert.equal(wrapBeat(10, 8, 16), 10);
  assert.equal(wrapBeat(16, 8, 16), 8);
  assert.equal(wrapBeat(21, 8, 16), 13);
  assert.equal(wrapBeat(2, 8, 16), 2); // before the window: plays on into it
  assert.equal(beatsAfter(14, 2, 120, 16, 8), 10); // 4 beats on from 14: 18 → 10
  assert.equal(beatsAfter(14, 2, 120, 16), 2); // no loop start: round to the top
  assert.deepEqual(clampWindow(2, 6), { start: 2, end: 6 });
  assert.deepEqual(clampWindow(9, 6), { start: 5, end: 6 }); // start stays before the end
  assert.deepEqual(clampWindow(-3, 99), { start: 0, end: 16 });
  assert.deepEqual(clampWindow('x', 4), { start: 0, end: 4 });
});
