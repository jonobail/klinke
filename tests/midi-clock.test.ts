// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTINUE,
  DEFAULT_MIDI_SETTINGS,
  ClockLine,
  PPQN,
  START,
  TempoEstimator,
  beatAtTicks,
  loopDiff,
  parseMidiSettings,
  sppBeats,
  sppBytes,
  startPoint,
  tempoMoved,
} from '../src/app/core/midi-clock.ts';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

/** Tick times for a steady clock at `bpm`, from `t0`, with optional jitter per tick. */
const ticks = (bpm: number, n: number, t0 = 1000, jitter = (_i: number) => 0) =>
  Array.from({ length: n }, (_, i) => t0 + (i * 60000) / (bpm * PPQN) + jitter(i));

test('song position pointers are 14-bit sixteenths, LSB first', () => {
  assert.deepEqual(sppBytes(0), [0xf2, 0, 0]);
  assert.deepEqual(sppBytes(144), [0xf2, 0x10, 0x01]);
  assert.deepEqual(sppBytes(0x3fff), [0xf2, 0x7f, 0x7f]);
  assert.deepEqual(sppBytes(99999), [0xf2, 0x7f, 0x7f]); // clamped
  assert.deepEqual(sppBytes(-3), [0xf2, 0, 0]);
  assert.equal(sppBeats(16), 4); // one bar
});

test('clock starts from the top with START, from anywhere else with CONTINUE', () => {
  assert.deepEqual(startPoint(0), { spp: 0, beat: 0, message: START });
  assert.deepEqual(startPoint(4), { spp: 16, beat: 4, message: CONTINUE });
  // Between sixteenths: wait for the next one (a pointer can't say anything finer).
  assert.deepEqual(startPoint(4.1), { spp: 17, beat: 4.25, message: CONTINUE });
  // A hair past a sixteenth (float noise) counts as on it.
  assert.deepEqual(startPoint(4.25 + 1e-9), { spp: 17, beat: 4.25, message: CONTINUE });
});

test('loop distance takes the short way round', () => {
  assert.equal(loopDiff(1, 0.5, 64), 0.5);
  assert.equal(loopDiff(0.5, 1, 64), -0.5);
  close(loopDiff(0.1, 63.9, 64), 0.2); // across the wrap
  close(loopDiff(63.9, 0.1, 64), -0.2);
  assert.equal(loopDiff(70, 6, 64), 0);
});

test('beats from ticks wrap at the song loop', () => {
  assert.equal(beatAtTicks(0, 24, 64), 1);
  assert.equal(beatAtTicks(4, 12, 64), 4.5);
  assert.equal(beatAtTicks(63, 48, 64), 1);
});

test('clock line hands out each tick once, in order, up to the horizon', () => {
  const line = new ClockLine(0, 1000, 120); // 120 BPM: a tick every 20.833 ms
  const first = line.take(1100);
  assert.equal(first.length, 5); // ticks at 0, 20.8, 41.7, 62.5, 83.3 ms
  close(first[0], 1000);
  close(first[4], 1000 + (4 * 500) / 24);
  assert.deepEqual(line.take(1100), []); // nothing twice
  const next = line.take(1500);
  assert.equal(first.length + next.length, 24); // one beat's worth by 1.5 s (the 25th is at 1500)
  close(next[0], 1000 + (5 * 500) / 24);
  assert.equal(line.next, 24);
});

test('clock line starting mid-song begins on the next tick', () => {
  const line = new ClockLine(4.25, 0, 120);
  assert.equal(line.next, 4.25 * 24);
  close(line.take(1)[0], 0);
  const odd = new ClockLine(1.01, 0, 60); // next tick is beat 25/24
  assert.equal(odd.next, 25);
  close(odd.take(1000)[0], (25 / 24 - 1.01) * 1000);
});

test('clock line follows a tempo change without repeating or skipping ticks', () => {
  const line = new ClockLine(0, 0, 120);
  const before = line.take(500); // one beat
  assert.equal(before.length, 24);
  // Double the tempo at 500 ms (beat 1).
  line.reanchor(line.beatAt(500), 500, 240);
  const after = line.take(750); // one more beat at 240
  assert.equal(after.length, 24);
  close(after[0], 500);
  close(after[1] - after[0], 250 / 24);
  assert.equal(line.next, 48);
});

test('clock line never sends a tick earlier than one already sent', () => {
  const line = new ClockLine(0, 0, 60);
  const sent = line.take(100); // ticks at 0, 41.7, 83.3
  assert.equal(sent.length, 3);
  // Bent so the next ticks would fall before the ones already sent: they go out straight after.
  line.reanchor(1, 0, 60);
  const later = line.take(200);
  assert.ok(later.length > 0);
  assert.equal(later[0], sent[2]);
  for (let i = 1; i < later.length; i++) assert.ok(later[i] >= later[i - 1]);
});

test('tempo estimator reads a steady clock', () => {
  const est = new TempoEstimator();
  assert.equal(est.bpm(), null);
  for (const t of ticks(128, 4)) est.push(t);
  assert.equal(est.bpm(), null); // too few to tell
  for (const t of ticks(128, 49)) est.push(t);
  close(est.bpm()!, 128, 1e-6);
});

test('tempo estimator smooths jitter', () => {
  const est = new TempoEstimator();
  // ±1.5 ms of USB-style jitter on a 140 BPM clock (17.9 ms a tick).
  const jitter = (i: number) => ((i * 7919) % 31) / 10 - 1.5;
  for (const t of ticks(140, 200, 0, jitter)) est.push(t);
  close(est.bpm()!, 140, 0.5);
});

test('tempo estimator drops a lost tick and a burst', () => {
  const est = new TempoEstimator();
  const ts = ticks(120, 60);
  ts.splice(30, 1); // a dropped tick: one interval twice as long
  for (const t of ts) est.push(t);
  close(est.bpm()!, 120, 1e-6);
});

test('tempo estimator follows a real tempo change', () => {
  const est = new TempoEstimator();
  const slow = ticks(90, 60, 0);
  for (const t of slow) est.push(t);
  close(est.bpm()!, 90, 1e-6);
  for (const t of ticks(180, 100, slow.at(-1)! + 60000 / (180 * PPQN))) est.push(t);
  close(est.bpm()!, 180, 1e-6);
});

test('tempo estimator starts afresh after the clock pauses', () => {
  const est = new TempoEstimator();
  for (const t of ticks(100, 60, 0)) est.push(t);
  for (const t of ticks(150, 3, 10000)) est.push(t);
  assert.equal(est.bpm(), null); // the gap reset it; not enough new ticks yet
  for (const t of ticks(150, 60, 10000)) est.push(t);
  close(est.bpm()!, 150, 1e-6);
});

test('small tempo wobbles are ignored', () => {
  assert.equal(tempoMoved(120, 120.3), false);
  assert.equal(tempoMoved(120, 120.6), true);
  assert.equal(tempoMoved(120, 119.4), true);
});

test('MIDI settings load safely', () => {
  assert.deepEqual(parseMidiSettings(null), DEFAULT_MIDI_SETTINGS);
  assert.deepEqual(parseMidiSettings('junk'), DEFAULT_MIDI_SETTINGS);
  assert.deepEqual(
    parseMidiSettings({ clockOut: 'yes', sync: 'sideways', output: 3 }),
    DEFAULT_MIDI_SETTINGS,
  );
  assert.deepEqual(
    parseMidiSettings({ clockOut: true, output: 'Port 2', sync: 'external', input: 'Keys' }),
    { clockOut: true, output: 'Port 2', sync: 'external', input: 'Keys' },
  );
});
