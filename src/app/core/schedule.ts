// Look-ahead scheduling maths: which notes and beats fall in a stretch of the song that is about
// to play, and how far into that stretch each one lands, so they can be booked on the audio
// clock ahead of time. Pure, tested in tests/schedule.test.ts.

import type { Note } from './notes.ts';

/**
 * How many beats the song moves from `from` to `to`, going round the loop (from the loop end
 * back to `loopStart`) when `to` is behind `from`.
 */
export function beatDistance(from: number, to: number, loopStart: number, loopEnd: number): number {
  if (to >= from) return to - from;
  return Math.max(0, loopEnd - from) + Math.max(0, to - loopStart);
}

/** The song stretch [from, to) as up to two plain pieces, each with its distance from `from`. */
function pieces(from: number, to: number, loopStart: number, loopEnd: number) {
  if (to >= from) return [{ a: from, b: to, base: 0 }];
  return [
    { a: from, b: loopEnd, base: 0 },
    { a: loopStart, b: to, base: Math.max(0, loopEnd - from) },
  ];
}

export interface Due<T> {
  item: T;
  /** Beats from the start of the window to where it plays. */
  offset: number;
}

/**
 * Notes of a track that start in the song window [from, to), with how far into the window each
 * one plays. The song wraps from `loopEnd` back to `loopStart`; the track itself repeats every
 * `trackLoop` beats (its notes from `trackLoop` on never play). `wrapped` says the track's own
 * loop came round inside the window. Sorted by offset.
 */
export function notesDue(
  notes: Note[],
  from: number,
  to: number,
  loopStart: number,
  loopEnd: number,
  trackLoop: number,
): { due: Due<Note>[]; wrapped: boolean } {
  const due: Due<Note>[] = [];
  let wrapped = false;
  const live = notes.filter((n) => n.start < trackLoop);
  const span = (lo: number, hi: number, base: number) => {
    for (const n of live)
      if (n.start >= lo && n.start < hi) due.push({ item: n, offset: base + n.start - lo });
  };
  for (const { a, b, base } of pieces(from, to, loopStart, loopEnd)) {
    const len = b - a;
    if (len <= 0) continue;
    const at = ((a % trackLoop) + trackLoop) % trackLoop;
    if (at + len <= trackLoop) span(at, at + len, base);
    else {
      // Round the track's loop inside this piece.
      wrapped = true;
      span(at, trackLoop, base);
      span(0, at + len - trackLoop, base + trackLoop - at);
    }
    // A piece that starts the song loop over starts the track over too.
    if (base > 0) wrapped = true;
  }
  due.sort((x, y) => x.offset - y.offset);
  return { due, wrapped };
}

/**
 * Whole beats (song positions) in the window [from, to), with their offsets: what a metronome
 * clicks on. `beat` is the song position of each click.
 */
export function beatsDue(
  from: number,
  to: number,
  loopStart: number,
  loopEnd: number,
): { beat: number; offset: number }[] {
  const out: { beat: number; offset: number }[] = [];
  for (const { a, b, base } of pieces(from, to, loopStart, loopEnd)) {
    for (let beat = Math.ceil(a - 1e-9) || 0; beat < b - 1e-9; beat++) {
      out.push({ beat, offset: base + Math.max(0, beat - a) });
    }
  }
  return out;
}
