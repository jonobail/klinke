// Recording options (metronome, count-in, latency compensation) and their maths. Pure, tested in
// tests/metronome.test.ts.

import { BEATS_PER_BAR } from './transport.ts';

export interface RecOptions {
  /** The metronome clicks while the song plays. */
  click: boolean;
  /** Bars of clicks before recording starts from a stopped song (0 = straight in). */
  countIn: 0 | 1 | 2;
  /**
   * Move what's recorded earlier by the time the sound takes to reach you (the audio output's
   * latency, as the browser reports it), so it lands where you heard it.
   */
  autoLatency: boolean;
  /** More (or, negative, less) to move it by, in ms: MIDI gear and ears have latency too. */
  offsetMs: number;
}

export const DEFAULT_REC_OPTIONS: RecOptions = {
  click: false,
  countIn: 1,
  autoLatency: true,
  offsetMs: 0,
};

export const OFFSET_MIN = -100;
export const OFFSET_MAX = 250;

export function parseRecOptions(raw: unknown): RecOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof RecOptions, unknown>
  >;
  const off = Number(r.offsetMs);
  return {
    click: r.click === true,
    countIn: r.countIn === 0 || r.countIn === 2 ? r.countIn : 1,
    autoLatency: r.autoLatency !== false,
    offsetMs: Number.isFinite(off)
      ? Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, Math.round(off)))
      : 0,
  };
}

/**
 * How much to move recorded material earlier, in seconds: the output latency (when auto is on)
 * plus the manual offset. Never negative overall.
 */
export function recLatency(o: RecOptions, outputLatency: number): number {
  const auto = o.autoLatency && Number.isFinite(outputLatency) ? Math.max(0, outputLatency) : 0;
  return Math.max(0, auto + o.offsetMs / 1000);
}

/** Seconds → beats at a tempo. */
export const secondsToBeats = (s: number, bpm: number) => (s * bpm) / 60;

/**
 * A song position moved earlier by `beats`, kept inside a track's loop of `loop` beats (a note
 * played just after the loop came round belongs at its end).
 */
export function earlier(beat: number, beats: number, loop: number): number {
  const b = beat - beats;
  return ((b % loop) + loop) % loop;
}

/** A click on beat 1 of the bar is the accented one. */
export const accented = (beat: number) =>
  ((Math.round(beat) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;

/** The click's pitch (Hz): higher on the downbeat. */
export const clickPitch = (beat: number) => (accented(beat) ? 1760 : 1175);
