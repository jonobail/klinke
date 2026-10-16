// Piano-roll editing: moving, transposing, copying and step-entering groups of notes. Pure,
// tested in tests/editing.test.ts.

import { type Grid, MIN_LENGTH, type Note, gridBeats, sortNotes } from './notes.ts';
import { SONG_BEATS } from './transport.ts';

export type Ids = ReadonlySet<string>;

/** Pitches notes are kept within (MIDI's 0–127, or what the roll shows). */
export interface Range {
  lo: number;
  hi: number;
}
const MIDI: Range = { lo: 0, hi: 127 };
const EPS = 1e-6;

/** One grid step in beats; a 1/16 with the grid off. */
export const stepBeats = (grid: Grid) => gridBeats(grid) || 0.25;

export const pick = (notes: Note[], ids: Ids) => notes.filter((n) => ids.has(n.id));
export const deleteNotes = (notes: Note[], ids: Ids) => notes.filter((n) => !ids.has(n.id));

/**
 * Moves `origin` (the notes as they were when a drag began) by `dBeats` and `dSemis` as a group:
 * the offsets are clamped so the group stays inside the song and `range` (a group already outside
 * isn't pushed back in). Notes in `notes` take their origin's moved position; others are untouched.
 */
export function offsetNotes(
  notes: Note[],
  origin: Note[],
  dBeats: number,
  dSemis: number,
  range: Range = MIDI,
): Note[] {
  if (!origin.length) return notes;
  const first = Math.min(...origin.map((n) => n.start));
  const end = Math.max(...origin.map((n) => n.start + n.length));
  const low = Math.min(...origin.map((n) => n.note));
  const high = Math.max(...origin.map((n) => n.note));
  const db = Math.max(Math.min(0, -first), Math.min(Math.max(0, SONG_BEATS - end), dBeats));
  const ds = Math.max(
    Math.min(0, range.lo - low),
    Math.min(Math.max(0, range.hi - high), Math.round(dSemis)),
  );
  const from = new Map(origin.map((n) => [n.id, n]));
  return sortNotes(
    notes.map((n) => {
      const o = from.get(n.id);
      return o ? { ...n, start: o.start + db, note: o.note + ds } : n;
    }),
  );
}

export const transposeNotes = (notes: Note[], ids: Ids, semis: number, range: Range = MIDI) =>
  offsetNotes(notes, pick(notes, ids), 0, semis, range);

export const shiftNotes = (notes: Note[], ids: Ids, beats: number) =>
  offsetNotes(notes, pick(notes, ids), beats, 0);

/** Lengthens (or shortens) each of `origin` by `dLength`, at least MIN_LENGTH, within the song. */
export function resizeNotes(notes: Note[], origin: Note[], dLength: number): Note[] {
  const from = new Map(origin.map((n) => [n.id, n]));
  return notes.map((n) => {
    const o = from.get(n.id);
    if (!o) return n;
    return {
      ...n,
      length: Math.max(MIN_LENGTH, Math.min(SONG_BEATS - n.start, o.length + dLength)),
    };
  });
}

export const clampVelocity = (v: number) => Math.max(1, Math.min(127, Math.round(v)));

export const setVelocity = (notes: Note[], ids: Ids, velocity: number) =>
  notes.map((n) => (ids.has(n.id) ? { ...n, velocity: clampVelocity(velocity) } : n));

// ── Box select ──────────────────────────────────────────

/** A drag rectangle in beats and pitches (either corner first; pitches inclusive). */
export interface Box {
  from: number;
  to: number;
  low: number;
  high: number;
}

/** Ids of the notes the box touches. */
export function notesInBox(notes: Note[], box: Box): string[] {
  const [b0, b1] = [Math.min(box.from, box.to), Math.max(box.from, box.to)];
  const [lo, hi] = [Math.min(box.low, box.high), Math.max(box.low, box.high)];
  return notes
    .filter((n) => n.start < b1 && n.start + n.length > b0 && n.note >= lo && n.note <= hi)
    .map((n) => n.id);
}

// ── Copy, paste, duplicate ─────────────────────────────

/** Copied notes, starting from 0, and the block they span. */
export interface Clip {
  notes: Note[];
  /** Where the block started in the song. */
  origin: number;
  /** How long the block is: whole grid steps, so copies laid end to end stay on the grid. */
  span: number;
}

export function copyNotes(notes: Note[], ids: Ids, grid: Grid): Clip | null {
  const sel = pick(notes, ids);
  if (!sel.length) return null;
  const step = gridBeats(grid);
  const first = Math.min(...sel.map((n) => n.start));
  const end = Math.max(...sel.map((n) => n.start + n.length));
  const origin = step ? Math.floor(first / step + EPS) * step : first;
  const span = step ? Math.ceil((end - origin) / step - EPS) * step : end - origin;
  return { notes: sel.map((n) => ({ ...n, start: n.start - origin })), origin, span };
}

/** Puts a clip's notes in at beat `at` with fresh ids (any past the song's end are dropped). */
export function pasteNotes(
  notes: Note[],
  clip: Clip,
  at: number,
  makeId: () => string,
): { notes: Note[]; ids: Set<string> } {
  const placed = clip.notes
    .filter((n) => at + n.start < SONG_BEATS - EPS)
    .map((n) => ({
      ...n,
      id: makeId(),
      start: at + n.start,
      length: Math.min(n.length, SONG_BEATS - at - n.start),
    }));
  return { notes: sortNotes([...notes, ...placed]), ids: new Set(placed.map((n) => n.id)) };
}

/** A copy of the selected notes straight after them. */
export function duplicateNotes(notes: Note[], ids: Ids, grid: Grid, makeId: () => string) {
  const clip = copyNotes(notes, ids, grid);
  return clip
    ? pasteNotes(notes, clip, clip.origin + clip.span, makeId)
    : { notes, ids: new Set<string>() };
}

// ── Step entry ──────────────────────────────────────────

/** The step at or before `beat`, inside the loop. */
export const snapStep = (beat: number, step: number, loop: number) =>
  Math.max(0, Math.min(Math.ceil(loop / step - EPS) - 1, Math.floor(beat / step + EPS))) * step;

/** The next step, back to the top at the end of the loop. */
export const nextStep = (at: number, step: number, loop: number) =>
  at + step >= loop - EPS ? 0 : at + step;

/** The step before, round to the last step of the loop from the top. */
export const prevStep = (at: number, step: number, loop: number) =>
  at - step < -EPS ? snapStep(loop - EPS, step, loop) : at - step;

/** Writes `pitch` at `at`, `length` long, replacing a note of the same pitch starting there. */
export function stepWrite(
  notes: Note[],
  pitch: number,
  at: number,
  length: number,
  velocity: number,
  id: string,
): Note[] {
  const kept = notes.filter((n) => !(n.note === pitch && Math.abs(n.start - at) < EPS));
  const n: Note = {
    id,
    note: Math.max(0, Math.min(127, Math.round(pitch))),
    start: at,
    length: Math.max(MIN_LENGTH, Math.min(SONG_BEATS - at, length)),
    velocity: clampVelocity(velocity),
  };
  return sortNotes([...kept, n]);
}

/** TIE: the notes in `ids` that end at `at` grow by `beats`. Returns the ids that grew. */
export function tieNotes(notes: Note[], ids: Ids, at: number, beats: number) {
  const tied = new Set(
    pick(notes, ids)
      .filter((n) => Math.abs(n.start + n.length - at) < EPS)
      .map((n) => n.id),
  );
  return {
    notes: notes.map((n) =>
      tied.has(n.id) ? { ...n, length: Math.min(SONG_BEATS - n.start, n.length + beats) } : n,
    ),
    tied,
  };
}

/**
 * BACK, after stepping back to `at`: of the step-entered notes (`ids`), those starting on that
 * step go and those tied across it end where it starts.
 */
export function stepErase(notes: Note[], ids: Ids, at: number, step: number): Note[] {
  return notes.flatMap((n) => {
    if (!ids.has(n.id)) return [n];
    if (n.start >= at - EPS && n.start < at + step - EPS) return [];
    return n.start + n.length > at + EPS ? [{ ...n, length: at - n.start }] : [n];
  });
}
