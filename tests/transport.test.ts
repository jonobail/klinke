// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SONG_BEATS, beatsAfter, clampBpm, formatPosition } from '../src/app/core/transport.ts';

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
