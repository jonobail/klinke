// Song-position maths. Positions are in beats (quarter notes) from the start of bar 1.

export const BEATS_PER_BAR = 4;
export const SONG_BARS = 16;
export const SONG_BEATS = SONG_BARS * BEATS_PER_BAR;
export const BPM_MIN = 40;
export const BPM_MAX = 300;

export const clampBpm = (bpm: number) =>
  Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 10) / 10));

/** Loop lengths the song and each track can take, in bars. */
export const LOOP_BARS = [1, 2, 4, 8, 16] as const;

/** Beats elapsed after `seconds` at a tempo, wrapping at the end of the song loop. */
export const beatsAfter = (startBeat: number, seconds: number, bpm: number, loop = SONG_BEATS) =>
  (startBeat + (seconds * bpm) / 60) % loop;

/**
 * How many beats a track repeats over: its own loop (in bars; 0 = off) when that's shorter than
 * the song loop, otherwise the song loop.
 */
export const trackLoopBeats = (trackBars: number, songBeats: number) =>
  trackBars > 0 ? Math.min(trackBars * BEATS_PER_BAR, songBeats) : songBeats;

/** Song positions where each repeat of a `loop`-beat track begins, within the song loop. */
export function loopRepeats(loop: number, songBeats: number): number[] {
  const out: number[] = [];
  for (let at = 0; at < songBeats - 1e-9; at += loop) out.push(at);
  return out;
}

/** Nearest allowed loop length (bars) to `bars`; `withOff` lets 0 (no track loop) through. */
export function clampLoop(bars: unknown, withOff: boolean): number {
  const n = Number(bars);
  if (withOff && n === 0) return 0;
  return LOOP_BARS.includes(n as (typeof LOOP_BARS)[number]) ? n : withOff ? 0 : SONG_BARS;
}

/** Bar.beat.sixteenth, one-based, the way the counter shows it: `006.3.1`. */
export function formatPosition(beats: number): string {
  const sixteenths = Math.floor(beats * 4 + 1e-9);
  const bar = Math.floor(sixteenths / (BEATS_PER_BAR * 4)) + 1;
  const beat = (Math.floor(sixteenths / 4) % BEATS_PER_BAR) + 1;
  const six = (sixteenths % 4) + 1;
  return `${String(bar).padStart(3, '0')}.${beat}.${six}`;
}
