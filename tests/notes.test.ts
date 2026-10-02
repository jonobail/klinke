// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_LENGTH,
  addNote,
  gridBeats,
  moveNote,
  notesStarting,
  parseNotes,
  quantize,
  recordedNote,
  removeNote,
  resizeNote,
} from '../src/app/core/notes.ts';
import { SONG_BEATS } from '../src/app/core/transport.ts';

const n = (id: string, start: number, note = 60, length = 1) => ({
  id,
  note,
  start,
  length,
  velocity: 100,
});

test('grids in beats and quantising to the nearest line', () => {
  assert.deepEqual(
    ['OFF', '1/4', '1/8', '1/16', '1/32'].map((g) => gridBeats(g as never)),
    [0, 1, 0.5, 0.25, 0.125],
  );
  assert.equal(quantize(1.13, '1/16'), 1.25);
  assert.equal(quantize(1.1, '1/16'), 1);
  assert.equal(quantize(2.6, '1/4'), 3);
  assert.equal(quantize(1.13, 'OFF'), 1.13);
});

test('recorded notes: start snaps, length is played but at least a step, wrap ends at the loop', () => {
  assert.deepEqual(recordedNote('a', 60, 4.07, 4.6, '1/16'), n('a', 4, 60, 0.5));
  assert.equal(recordedNote('b', 60, 4, 4.01, '1/16').length, 0.25); // a tap is one step long
  assert.equal(recordedNote('c', 60, 4, 4.01, 'OFF').length, MIN_LENGTH);
  const wrapped = recordedNote('d', 60, SONG_BEATS - 0.5, 0.75, '1/16');
  assert.equal(wrapped.start, SONG_BEATS - 0.5);
  assert.equal(wrapped.length, 0.5); // stops at the loop point
  // Snapping up to the very end of the song wraps to the top rather than past it.
  assert.ok(recordedNote('e', 60, SONG_BEATS - 0.01, SONG_BEATS - 0.005, '1/4').start < SONG_BEATS);
});

test('which notes start in a window, across the loop point too', () => {
  const notes = [n('a', 0), n('b', 2), n('c', SONG_BEATS - 1)];
  assert.deepEqual(
    notesStarting(notes, 0, 1).map((x) => x.id),
    ['a'],
  );
  assert.deepEqual(
    notesStarting(notes, 1, 3).map((x) => x.id),
    ['b'],
  );
  assert.deepEqual(
    notesStarting(notes, SONG_BEATS - 2, 0.5).map((x) => x.id),
    ['a', 'c'],
  );
});

test('editing: add sorted, move within bounds, resize, remove', () => {
  let notes = addNote([n('a', 2)], n('b', 1));
  assert.deepEqual(
    notes.map((x) => x.id),
    ['b', 'a'],
  );
  notes = moveNote(notes, 'a', -3, 200);
  assert.deepEqual([notes[0].start, notes[0].note], [0, 127]);
  notes = moveNote(notes, 'a', SONG_BEATS, 60);
  assert.equal(notes.find((x) => x.id === 'a')!.start, SONG_BEATS - 1);
  notes = resizeNote(notes, 'b', 0);
  assert.equal(notes.find((x) => x.id === 'b')!.length, MIN_LENGTH);
  assert.deepEqual(
    removeNote(notes, 'a').map((x) => x.id),
    ['b'],
  );
});

test('stored notes are validated', () => {
  const ok = parseNotes([
    n('a', 1),
    { note: 'x' },
    null,
    { note: 60, start: 999, length: 1 },
    { note: 300, start: 2, length: 1 },
  ]);
  assert.deepEqual(
    ok.map((x) => [x.note, x.start]),
    [
      [60, 1],
      [127, 2],
    ],
  );
  assert.deepEqual(parseNotes('nope'), []);
});
