// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beatDistance, beatsDue, notesDue } from '../src/app/core/schedule.ts';

const n = (id: string, start: number) => ({ id, note: 60, start, length: 0.25, velocity: 100 });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const ids = (r: { due: { item: { id: string } }[] }) => r.due.map((d) => d.item.id);

test('beat distance goes round the loop', () => {
  assert.equal(beatDistance(1, 3, 0, 64), 2);
  near(beatDistance(63.5, 0.25, 0, 64), 0.75);
  // A loop from bar 3: the end comes round to beat 8.
  near(beatDistance(31.9, 8.1, 8, 32), 0.2);
});

test('notes due in a window, with offsets into it', () => {
  const notes = [n('a', 0), n('b', 1), n('c', 1.5), n('d', 3)];
  const r = notesDue(notes, 0.9, 1.6, 0, 64, 64);
  assert.deepEqual(ids(r), ['b', 'c']);
  near(r.due[0].offset, 0.1);
  near(r.due[1].offset, 0.6);
  assert.equal(r.wrapped, false);
});

test('a window across the song loop end plays the loop start', () => {
  const notes = [n('first', 8), n('early', 0), n('last', 31.95)];
  // The song loops bars 3–8 (beats 8–32): notes before beat 8 never play there.
  const r = notesDue(notes, 31.9, 8.1, 8, 32, 32);
  assert.deepEqual(ids(r), ['last', 'first']);
  near(r.due[0].offset, 0.05);
  near(r.due[1].offset, 0.1);
  assert.equal(r.wrapped, true);
});

test("a track's own loop repeats inside the song", () => {
  // A one-bar track: the window 3.9–4.1 crosses its loop at beat 4.
  const r = notesDue([n('a', 0), n('late', 6)], 3.9, 4.1, 0, 64, 4);
  assert.deepEqual(ids(r), ['a']);
  near(r.due[0].offset, 0.1);
  assert.equal(r.wrapped, true);
  // Later repeats find the same notes.
  assert.deepEqual(ids(notesDue([n('a', 0)], 39.95, 40.05, 0, 64, 4)), ['a']);
});

test('metronome beats in a window', () => {
  assert.deepEqual(beatsDue(0, 0.1, 0, 64), [{ beat: 0, offset: 0 }]);
  assert.deepEqual(beatsDue(0.1, 0.9, 0, 64), []);
  const wrap = beatsDue(31.9, 8.2, 8, 32);
  assert.deepEqual(
    wrap.map((b) => b.beat),
    [8],
  );
  near(wrap[0].offset, 0.1);
});
