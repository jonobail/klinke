// Editing single audio takes on the timeline: moving them and trimming either end. Pure, tested
// in tests/takes.test.ts.
//
// A take's audio is never changed: `offset` is how far into the recording it starts playing and
// `duration` how long it plays, both in seconds, so a trim can always be pulled back out to the
// whole recording. Positions are in beats; `spb` is seconds per beat at the song tempo.

/** The fields of a take these edits touch. */
export interface TakeSpan {
  /** Where it starts in the song, in beats. */
  start: number;
  /** How long it plays, in seconds. */
  duration: number;
  /** Seconds into the recording where it starts playing (0 = from the top). */
  offset?: number;
}

/** Shortest a take can be trimmed to, in seconds. */
export const MIN_TAKE = 0.05;
/** Peaks per second in a take's waveform (see `peaks` in `wav.ts`). */
export const PEAKS_PER_S = 50;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Moves a take to start at `start` beats, kept inside the track's loop (`loop` beats). */
export function moveTake<T extends TakeSpan>(take: T, start: number, loop: number, spb: number): T {
  const len = take.duration / spb;
  return { ...take, start: clamp(start, 0, Math.max(0, loop - len)) };
}

/**
 * Moves a take's left edge to `start` beats: later trims the top off, earlier brings back what
 * was trimmed (as far as the recording goes and not before beat 0).
 */
export function trimTakeStart<T extends TakeSpan>(take: T, start: number, spb: number): T {
  const offset = take.offset ?? 0;
  const end = take.start + take.duration / spb;
  // Earliest: all the trimmed audio back, or beat 0. Latest: MIN_TAKE before the end.
  const lo = Math.max(0, take.start - offset / spb);
  const s = clamp(start, lo, end - MIN_TAKE / spb);
  const moved = (s - take.start) * spb;
  return { ...take, start: s, offset: offset + moved, duration: take.duration - moved };
}

/**
 * Moves a take's right edge to `end` beats: earlier trims the tail, later brings it back, up to
 * the end of the recording (`full` seconds long) and the end of the loop.
 */
export function trimTakeEnd<T extends TakeSpan>(
  take: T,
  end: number,
  full: number,
  loop: number,
  spb: number,
): T {
  const offset = take.offset ?? 0;
  const hi = Math.min(take.start + (full - offset) / spb, loop);
  const e = clamp(end, take.start + MIN_TAKE / spb, Math.max(take.start + MIN_TAKE / spb, hi));
  return { ...take, duration: (e - take.start) * spb };
}

/** How long the whole recording behind a take is, in seconds, from its waveform. */
export const recordedLength = (take: TakeSpan & { peaks: number[] }) =>
  Math.max(take.duration + (take.offset ?? 0), take.peaks.length / PEAKS_PER_S);

/** The slice of the waveform that plays, as [first, last) peak indices. */
export function visiblePeaks(take: TakeSpan & { peaks: number[] }): [number, number] {
  const a = Math.floor((take.offset ?? 0) * PEAKS_PER_S);
  const b = Math.ceil(((take.offset ?? 0) + take.duration) * PEAKS_PER_S);
  return [Math.min(a, take.peaks.length), Math.min(Math.max(a, b), take.peaks.length)];
}
