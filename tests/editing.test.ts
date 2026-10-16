// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyNotes,
  deleteNotes,
  duplicateNotes,
  nextStep,
  notesInBox,
  offsetNotes,
  pasteNotes,
  prevStep,
  resizeNotes,
  setVelocity,
  shiftNotes,
  snapStep,
  stepBeats,
  stepErase,
  stepWrite,
  tieNotes,
  transposeNotes,
} from '../src/app/core/editing.ts';
import { MIN_LENGTH } from '../src/app/core/notes.ts';
import { SONG_BEATS } from '../src/app/core/transport.ts';

const n = (id: string, start: number, note = 60, length = 1, velocity = 100) => ({
  id,
  note,
  start,
  length,
  velocity,
});
const ids = (...xs: string[]) => new Set(xs);
const counter = () => {
  let i = 0;
  return () => `p${i++}`;
};

test('a group moves together and stays inside the song and the pitch range', () => {
  const notes = [n('a', 0, 60), n('b', 2, 64), n('c', 8, 40)];
  const moved = offsetNotes(notes, notes.slice(0, 2), 1, 2);
  assert.deepEqual(
    moved.map((x) => [x.id, x.start, x.note]),
    [
      ['a', 1, 62],
      ['b', 3, 66],
      ['c', 8, 40],
    ],
  );
  // Clamped as a group: 'a' can't go before beat 0, so 'b' keeps its distance.
  const early = offsetNotes(notes, notes.slice(0, 2), -5, 0);
  assert.deepEqual(
    early.map((x) => x.start),
    [0, 2, 8],
  );
  const high = transposeNotes(notes, ids('a', 'b'), 12, { lo: 12, hi: 70 });
  assert.deepEqual(
    high.filter((x) => x.id !== 'c').map((x) => x.note),
    [66, 70], // 'b' tops out at 70, 'a' keeps the third below
  );
  // Already outside the range: not pushed back in.
  assert.equal(transposeNotes([n('lo', 0, 5)], ids('lo'), 1, { lo: 12, hi: 108 })[0].note, 6);
  const late = shiftNotes([n('end', SONG_BEATS - 1)], ids('end'), 4);
  assert.equal(late[0].start, SONG_BEATS - 1);
});

test('resizing, velocity and deleting a selection', () => {
  const notes = [n('a', 0, 60, 1), n('b', 1, 62, 0.5), n('c', 4)];
  const longer = resizeNotes(notes, notes.slice(0, 2), -0.75);
  assert.deepEqual(
    longer.map((x) => x.length),
    [0.25, MIN_LENGTH, 1],
  );
  const loud = setVelocity(notes, ids('a', 'c'), 200);
  assert.deepEqual(
    loud.map((x) => x.velocity),
    [127, 100, 127],
  );
  assert.equal(setVelocity(notes, ids('b'), 0)[1].velocity, 1);
  assert.deepEqual(
    deleteNotes(notes, ids('a', 'c')).map((x) => x.id),
    ['b'],
  );
});

test('box select picks the notes it touches', () => {
  const notes = [n('a', 0, 60), n('b', 2, 64), n('c', 4, 72)];
  assert.deepEqual(notesInBox(notes, { from: 2.5, to: 0.5, low: 64, high: 58 }), ['a', 'b']);
  assert.deepEqual(notesInBox(notes, { from: 1, to: 2, low: 0, high: 127 }), []); // 'a' ends at 1
  assert.deepEqual(notesInBox(notes, { from: 0, to: 9, low: 70, high: 75 }), ['c']);
});

test('copy and paste keeps the block on the grid', () => {
  const notes = [n('a', 1.25, 60, 0.5), n('b', 2, 64, 0.25)];
  const clip = copyNotes(notes, ids('a', 'b'), '1/4')!;
  assert.equal(clip.origin, 1);
  assert.equal(clip.span, 2); // 1 → 2.25, rounded up to whole beats
  assert.deepEqual(
    clip.notes.map((x) => x.start),
    [0.25, 1],
  );
  const pasted = pasteNotes(notes, clip, 8, counter());
  assert.equal(pasted.notes.length, 4);
  assert.deepEqual([...pasted.ids], ['p0', 'p1']);
  assert.deepEqual(
    pasted.notes.filter((x) => pasted.ids.has(x.id)).map((x) => x.start),
    [8.25, 9],
  );
  // Past the end of the song: dropped, or cut at the end.
  const tail = pasteNotes([], clip, SONG_BEATS - 0.5, counter());
  assert.deepEqual(
    tail.notes.map((x) => [x.start, x.length]),
    [[SONG_BEATS - 0.25, 0.25]],
  );
  assert.equal(copyNotes(notes, ids(), '1/4'), null);
  assert.equal(copyNotes(notes, ids('a'), 'OFF')!.span, 0.5);
});

test('duplicate lands straight after the selection', () => {
  const notes = [n('a', 0, 60, 0.25), n('b', 0.5, 62, 0.25)];
  const dup = duplicateNotes(notes, ids('a', 'b'), '1/16', counter());
  assert.deepEqual(
    dup.notes.map((x) => [x.id, x.start]),
    [
      ['a', 0],
      ['b', 0.5],
      ['p0', 0.75],
      ['p1', 1.25],
    ],
  );
  assert.equal(duplicateNotes(notes, ids(), '1/16', counter()).notes, notes);
});

test('step cursor moves by steps round the loop', () => {
  assert.equal(stepBeats('1/8'), 0.5);
  assert.equal(stepBeats('OFF'), 0.25);
  assert.equal(snapStep(1.7, 0.5, 16), 1.5);
  assert.equal(snapStep(40, 0.5, 16), 15.5);
  assert.equal(snapStep(-1, 0.5, 16), 0);
  assert.equal(nextStep(15.5, 0.5, 16), 0);
  assert.equal(nextStep(2, 0.5, 16), 2.5);
  assert.equal(prevStep(0, 0.5, 16), 15.5);
  assert.equal(prevStep(0, 1 / 3, 1), 2 / 3);
});

test('step entry writes, ties and steps back', () => {
  let notes = stepWrite([], 60, 1, 0.25, 90, 's1');
  notes = stepWrite(notes, 64, 1, 0.25, 90, 's2');
  assert.deepEqual(
    notes.map((x) => [x.note, x.start, x.length, x.velocity]),
    [
      [60, 1, 0.25, 90],
      [64, 1, 0.25, 90],
    ],
  );
  // Same pitch on the same step replaces the old one.
  assert.deepEqual(
    stepWrite(notes, 60, 1, 0.25, 50, 's3').map((x) => x.id),
    ['s3', 's2'], // sorted by pitch
  );
  const { notes: tied, tied: grew } = tieNotes(notes, ids('s1', 's2'), 1.25, 0.25);
  assert.deepEqual([...grew], ['s1', 's2']);
  assert.deepEqual(
    tied.map((x) => x.length),
    [0.5, 0.5],
  );
  // Nothing ends at the cursor (a rest came between): no tie.
  assert.equal(tieNotes(notes, ids('s1'), 2, 0.25).tied.size, 0);
  // BACK onto the tied step shortens; BACK onto the first step removes.
  const back = stepErase([...tied, n('other', 1.25, 50)], ids('s1', 's2'), 1.25, 0.25);
  assert.deepEqual(
    back.map((x) => [x.id, x.length]),
    [
      ['s1', 0.25],
      ['s2', 0.25],
      ['other', 1],
    ],
  );
  assert.deepEqual(
    stepErase(back, ids('s1', 's2'), 1, 0.25).map((x) => x.id),
    ['other'],
  );
});
