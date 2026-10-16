// MIDI-style note tracks: notes in beats on the song timeline, quantising, recording, editing and
// finding which notes are due. Pure, tested in tests/notes.test.ts.

import { SONG_BEATS } from './transport.ts';

export interface Note {
  id: string;
  /** MIDI note number. */
  note: number;
  /** Start and length in beats (quarter notes) from the top of the song. */
  start: number;
  length: number;
  /** 1–127. Recorded from MIDI; 100 from the computer keyboard and drawing. */
  velocity: number;
}

/** Grid choices, as a fraction of a whole note; the beat value is 4 × that. */
export const GRIDS = ['OFF', '1/4', '1/8', '1/16', '1/32'] as const;
export type Grid = (typeof GRIDS)[number];
export const DEFAULT_GRID: Grid = '1/16';
export const gridBeats = (g: Grid) => (g === 'OFF' ? 0 : 4 / Number(g.split('/')[1]));

/** Shortest note allowed: a 1/32 note (an eighth of a beat). */
export const MIN_LENGTH = 0.125;

/** Snaps a beat position to the grid (nearest line); OFF leaves it alone. */
export function quantize(beats: number, grid: Grid): number {
  const step = gridBeats(grid);
  return step ? Math.round(beats / step) * step : beats;
}

/**
 * A recorded note from its key-down and key-up positions. The start snaps to the grid; the length
 * is kept as played but is at least one grid step (or MIN_LENGTH with the grid off) and stops at
 * the end of the song loop. A key held across the loop point ends at the loop point.
 */
export function recordedNote(
  id: string,
  note: number,
  downBeat: number,
  upBeat: number,
  grid: Grid,
  velocity = 100,
  loop = SONG_BEATS,
): Note {
  // Positions are within the track's loop (the whole song unless the track loops shorter).
  downBeat %= loop;
  upBeat %= loop;
  const start = Math.min(quantize(downBeat, grid), loop - MIN_LENGTH) % loop;
  const played = upBeat >= downBeat ? upBeat - downBeat : loop - downBeat;
  const step = gridBeats(grid) || MIN_LENGTH;
  const length = Math.min(
    Math.max(step, step ? Math.round(played / step) * step : played),
    loop - start,
  );
  return { id, note, start, length, velocity };
}

/**
 * Notes starting in [from, to). `to < from` means the window wrapped round the loop; notes from
 * `loop` on are past the end of a looping track and never play.
 */
export function notesStarting(notes: Note[], from: number, to: number, loop = Infinity): Note[] {
  const live = notes.filter((n) => n.start < loop);
  if (to >= from) return live.filter((n) => n.start >= from && n.start < to);
  return live.filter((n) => n.start >= from || n.start < to);
}

/**
 * REPLACE recording: drops the notes starting in [from, to) (wrapping like `notesStarting`),
 * except those in `keep` (just recorded). Returns `notes` itself when nothing goes.
 */
export function clearWindow(
  notes: Note[],
  from: number,
  to: number,
  keep: ReadonlySet<string>,
  loop = Infinity,
): Note[] {
  const gone = new Set(
    notesStarting(notes, from, to, loop)
      .filter((n) => !keep.has(n.id))
      .map((n) => n.id),
  );
  return gone.size ? notes.filter((n) => !gone.has(n.id)) : notes;
}

/** Sorted by start, then pitch (the order they're stored in). */
export const sortNotes = (notes: Note[]) =>
  [...notes].sort((a, b) => a.start - b.start || a.note - b.note);

export const addNote = (notes: Note[], n: Note) => sortNotes([...notes, n]);
export const removeNote = (notes: Note[], id: string) => notes.filter((n) => n.id !== id);

/** Move a note to a new start / pitch, kept inside the song and MIDI's 0–127. */
export function moveNote(notes: Note[], id: string, start: number, note: number): Note[] {
  return sortNotes(
    notes.map((n) =>
      n.id === id
        ? {
            ...n,
            start: Math.max(0, Math.min(SONG_BEATS - n.length, start)),
            note: Math.max(0, Math.min(127, Math.round(note))),
          }
        : n,
    ),
  );
}

/** Resize a note, at least MIN_LENGTH and not past the end of the song. */
export function resizeNote(notes: Note[], id: string, length: number): Note[] {
  return notes.map((n) =>
    n.id === id
      ? { ...n, length: Math.max(MIN_LENGTH, Math.min(SONG_BEATS - n.start, length)) }
      : n,
  );
}

/** Reads stored notes, dropping anything malformed. */
export function parseNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  return sortNotes(
    raw
      .filter(
        (n): n is Note =>
          !!n &&
          typeof n === 'object' &&
          [n.note, n.start, n.length].every((x) => Number.isFinite(x)) &&
          n.start >= 0 &&
          n.start < SONG_BEATS &&
          n.length > 0,
      )
      .map((n, i) => ({
        id: typeof n.id === 'string' ? n.id : `n${i}`,
        note: Math.max(0, Math.min(127, Math.round(n.note))),
        start: n.start,
        length: Math.min(n.length, SONG_BEATS - n.start),
        velocity: Number.isFinite(n.velocity) ? Math.max(1, Math.min(127, n.velocity)) : 100,
      })),
  );
}
