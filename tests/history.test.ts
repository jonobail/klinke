// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  record,
  redo,
  replace,
  startHistory,
  undo,
} from '../src/app/core/history.ts';

test('a fresh history has nothing to undo or redo', () => {
  const h = startHistory('a');
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
  assert.equal(undo(h), h);
  assert.equal(redo(h), h);
});

test('separate changes are separate steps; undo and redo walk them', () => {
  let h = startHistory('a');
  h = record(h, 'b', 1000);
  h = record(h, 'c', 5000);
  assert.deepEqual(h.past, ['a', 'b']);
  h = undo(h);
  assert.equal(h.present, 'b');
  h = undo(h);
  assert.equal(h.present, 'a');
  assert.equal(canUndo(h), false);
  h = redo(h);
  h = redo(h);
  assert.equal(h.present, 'c');
  assert.equal(canRedo(h), false);
});

test('rapid changes (a knob drag) join one step', () => {
  let h = startHistory('a');
  h = record(h, 'b', 1000);
  h = record(h, 'c', 1000 + COALESCE_MS / 2);
  h = record(h, 'd', 1000 + COALESCE_MS);
  assert.deepEqual(h.past, ['a']);
  assert.equal(undo(h).present, 'a');
});

test('a group (one recording pass) joins however slow, but starts its own step', () => {
  let h = startHistory('a');
  h = record(h, 'b', 1000);
  h = record(h, 'c', 10000, 'rec1');
  h = record(h, 'd', 20000, 'rec1');
  h = record(h, 'e', 30000, 'rec1');
  assert.deepEqual(h.past, ['a', 'b']);
  h = record(h, 'f', 40000, 'rec2');
  assert.deepEqual(h.past, ['a', 'b', 'e']);
});

test('a new change after undo drops the redo list', () => {
  let h = startHistory('a');
  h = record(h, 'b', 1000);
  h = undo(h);
  h = record(h, 'x', 1100); // just after the undo: still a step of its own
  assert.deepEqual(h.past, ['a']);
  assert.equal(canRedo(h), false);
  assert.equal(h.present, 'x');
});

test('the same state is no change; replace moves the present without a step', () => {
  let h = startHistory('a');
  assert.equal(record(h, 'a', 1000), h);
  h = replace(h, 'a2');
  assert.equal(h.present, 'a2');
  assert.equal(canUndo(h), false);
});

test('only the last HISTORY_LIMIT steps are kept', () => {
  let h = startHistory(0);
  for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = record(h, i, i * 10000);
  assert.equal(h.past.length, HISTORY_LIMIT);
  assert.equal(h.past[0], 50);
});
