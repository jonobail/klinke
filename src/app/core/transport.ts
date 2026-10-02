// Song-position maths. Positions are in beats (quarter notes) from the start of bar 1.

export const BEATS_PER_BAR = 4;
export const SONG_BARS = 16;
export const SONG_BEATS = SONG_BARS * BEATS_PER_BAR;
export const BPM_MIN = 40;
export const BPM_MAX = 300;

export const clampBpm = (bpm: number) =>
  Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 10) / 10));

/** Beats elapsed after `seconds` at a tempo, wrapping at the end of the song loop. */
export const beatsAfter = (startBeat: number, seconds: number, bpm: number) =>
  (startBeat + (seconds * bpm) / 60) % SONG_BEATS;

/** Bar.beat.sixteenth, one-based, the way the counter shows it: `006.3.1`. */
export function formatPosition(beats: number): string {
  const sixteenths = Math.floor(beats * 4 + 1e-9);
  const bar = Math.floor(sixteenths / (BEATS_PER_BAR * 4)) + 1;
  const beat = (Math.floor(sixteenths / 4) % BEATS_PER_BAR) + 1;
  const six = (sixteenths % 4) + 1;
  return `${String(bar).padStart(3, '0')}.${beat}.${six}`;
}
