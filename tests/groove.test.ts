// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampSwing,
  quantizeNotes,
  swingStep,
  swungNotes,
  swungStart,
} from '../src/app/core/groove.ts';
import { SONG_BEATS } from '../src/app/core/transport.ts';

const n = (id: string, start: number, length = 0.25) => ({
  id,
  note: 60,
  start,
  length,
  velocity: 100,
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('swing 50 is straight', () => {
  for (const s of [0, 0.25, 0.5, 0.75, 1.3]) assert.equal(swungStart(s, '1/16', 50), s);
});

test('swing delays the off-beats only', () => {
  // 66: a sixteenth off-beat moves 0.32 of a step; 75: half a step.
  near(swungStart(0.25, '1/16', 66), 0.25 + 0.32 * 0.25);
  near(swungStart(0.75, '1/16', 66), 0.75 + 0.32 * 0.25);
  near(swungStart(0.25, '1/16', 75), 0.375);
  for (const s of [0, 0.5, 1, 3.5]) assert.equal(swungStart(s, '1/16', 75), s);
  // Eighth grid: swing works on eighths.
  near(swungStart(0.5, '1/8', 75), 0.75);
  assert.equal(swungStart(1, '1/8', 75), 1);
  // A note a little off the off-beat keeps its distance from it.
  near(swungStart(0.26, '1/16', 75), 0.385);
});

test('grid OFF or coarser than an eighth swings sixteenths', () => {
  assert.equal(swingStep('OFF'), 0.25);
  assert.equal(swingStep('1/4'), 0.25);
  assert.equal(swingStep('1/8'), 0.5);
  assert.equal(swingStep('1/32'), 0.125);
  near(swungStart(0.25, 'OFF', 75), 0.375);
  near(swungStart(0.25, '1/4', 75), 0.375);
});

test('clampSwing keeps 50–75 and rounds', () => {
  assert.equal(clampSwing(40), 50);
  assert.equal(clampSwing(90), 75);
  assert.equal(clampSwing(62.4), 62);
  assert.equal(clampSwing('66'), 66);
  assert.equal(clampSwing(undefined), 50);
  assert.equal(clampSwing(NaN), 50);
  // Out-of-range swing is clamped when applied too.
  near(swungStart(0.25, '1/16', 100), 0.375);
});

test('swungNotes: as they play, kept inside the loop', () => {
  const notes = [n('a', 0), n('b', 0.25), n('c', 3.75), n('d', 5)];
  assert.deepEqual(
    swungNotes(notes, '1/16', 50, 4).map((x) => x.id),
    ['a', 'b', 'c'],
  );
  const [a, b, c] = swungNotes(notes, '1/16', 75, 4);
  assert.equal(a.start, 0);
  near(b.start, 0.375);
  // 3.75 swings to 3.875, still inside; a note right at the end can't spill past it.
  near(c.start, 3.875);
  const [last] = swungNotes([n('e', 3.875)], '1/32', 75, 4);
  assert.ok(last.start < 4);
  assert.equal(notes[1].start, 0.25, 'the stored notes are untouched');
});

test('quantizeNotes: strength 0, ½ and 1', () => {
  const notes = [n('a', 0.1), n('b', 0.9)];
  assert.deepEqual(quantizeNotes(notes, '1/4', 0), notes);
  const half = quantizeNotes(notes, '1/4', 0.5);
  near(half[0].start, 0.05);
  near(half[1].start, 0.95);
  assert.deepEqual(
    quantizeNotes(notes, '1/4', 1).map((x) => x.start),
    [0, 1],
  );
  assert.deepEqual(
    quantizeNotes(notes, '1/4').map((x) => x.length),
    [0.25, 0.25],
  );
});

test('quantizeNotes: only the chosen notes, and grid OFF changes nothing', () => {
  const notes = [n('a', 0.1), n('b', 0.9)];
  const some = quantizeNotes(notes, '1/4', 1, new Set(['b']));
  assert.deepEqual(
    some.map((x) => [x.id, x.start]),
    [
      ['a', 0.1],
      ['b', 1],
    ],
  );
  assert.equal(quantizeNotes(notes, 'OFF', 1), notes);
});

test('quantizeNotes keeps notes inside the song', () => {
  const [x] = quantizeNotes([n('z', SONG_BEATS - 0.1, 0.1)], '1/4', 1);
  assert.equal(x.start, SONG_BEATS - 1);
  assert.ok(x.start + x.length <= SONG_BEATS);
  const [y] = quantizeNotes([n('y', 0.05)], '1/4', 1);
  assert.equal(y.start, 0);
});
