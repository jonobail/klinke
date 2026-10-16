// Groove: quantising notes already on a track, and swing. Pure, tested in tests/groove.test.ts.
//
// Swing is a percentage, MPC style: 50 is straight, 66 is a triplet feel, 75 the most. It delays
// every second grid step (the off-beats) by (swing − 50) / 50 of a step; notes on the on-beats
// stay put. Swing is applied when a track plays, so the stored notes stay on the grid.

import { type Grid, type Note, gridBeats, sortNotes } from './notes.ts';
import { SONG_BEATS } from './transport.ts';

export const SWING_MIN = 50;
export const SWING_MAX = 75;
export const clampSwing = (s: unknown) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(SWING_MAX, Math.max(SWING_MIN, Math.round(n))) : SWING_MIN;
};

/** Swing works on this step when the track's grid is OFF or coarser than an eighth. */
export const swingStep = (grid: Grid) => {
  const g = gridBeats(grid);
  return g && g <= 0.5 ? g : 0.25;
};

/**
 * Where a note starting at `start` actually plays with swing: notes within half a step of an
 * off-beat grid line move later by (swing − 50) / 50 of a step, keeping their distance from it.
 */
export function swungStart(start: number, grid: Grid, swing: number): number {
  const s = clampSwing(swing);
  if (s === SWING_MIN) return start;
  const step = swingStep(grid);
  const index = Math.round(start / step);
  if (index % 2 === 0) return start;
  return start + ((s - SWING_MIN) / 50) * step;
}

/**
 * The notes of a track as they play, with swing applied to their starts. Notes from `loop` on
 * never play and are left out; a note swung past the loop end plays just before it instead.
 */
export function swungNotes(notes: Note[], grid: Grid, swing: number, loop = Infinity): Note[] {
  const live = notes.filter((n) => n.start < loop);
  if (clampSwing(swing) === SWING_MIN) return live;
  const last = loop - 1e-6;
  return live.map((n) => ({ ...n, start: Math.min(last, swungStart(n.start, grid, swing)) }));
}

/**
 * Moves each note's start towards its nearest grid line by `strength` (0–1; 1 snaps onto it).
 * Lengths are kept; with the grid OFF nothing changes. `ids` limits it to those notes.
 */
export function quantizeNotes(
  notes: Note[],
  grid: Grid,
  strength = 1,
  ids?: ReadonlySet<string>,
): Note[] {
  const step = gridBeats(grid);
  if (!step) return notes;
  const k = Math.min(1, Math.max(0, strength));
  return sortNotes(
    notes.map((n) => {
      if (ids && !ids.has(n.id)) return n;
      // The last grid line before the song's end, so a note near the end isn't pushed off it.
      const target = Math.min(Math.round(n.start / step) * step, SONG_BEATS - step);
      const start = Math.max(0, n.start + (target - n.start) * k);
      return { ...n, start, length: Math.min(n.length, SONG_BEATS - start) };
    }),
  );
}
