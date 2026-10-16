// MIDI clock maths: 24 ticks a beat, song position pointers, a tick scheduler for sending clock
// and a tempo estimator for following it. No Web MIDI here, so it all runs under node --test.

/** MIDI clock runs at 24 ticks (pulses) per quarter note. */
export const PPQN = 24;

export const CLOCK = 0xf8;
export const START = 0xfa;
export const CONTINUE = 0xfb;
export const STOP = 0xfc;
export const SONG_POSITION = 0xf2;

/** The largest song position a pointer can hold, in sixteenths (14 bits). */
export const SPP_MAX = 0x3fff;

/** Song position pointer message for a position in sixteenths. */
export function sppBytes(sixteenths: number): [number, number, number] {
  const n = Math.max(0, Math.min(SPP_MAX, Math.round(sixteenths)));
  return [SONG_POSITION, n & 0x7f, (n >> 7) & 0x7f];
}

/** Song position (beats) a pointer stands for. */
export const sppBeats = (sixteenths: number) => sixteenths / 4;

/**
 * Where clock out (re)starts from a song position in beats: the next sixteenth (a pointer can
 * only say sixteenths), its pointer, and START from the top or CONTINUE from anywhere else.
 */
export function startPoint(beat: number): { spp: number; beat: number; message: number } {
  const spp = Math.max(0, Math.min(SPP_MAX, Math.ceil(beat * 4 - 1e-6)));
  return { spp, beat: sppBeats(spp), message: spp === 0 ? START : CONTINUE };
}

/** Signed distance from `b` to `a` round a loop of `loop` beats, in (-loop/2, loop/2]. */
export function loopDiff(a: number, b: number, loop: number): number {
  const d = (((a - b) % loop) + loop) % loop;
  return d > loop / 2 ? d - loop : d;
}

/** Song position after `ticks` clock ticks from `startBeat`, wrapping at the song loop. */
export const beatAtTicks = (startBeat: number, ticks: number, loop: number) =>
  (startBeat + ticks / PPQN) % loop;

/**
 * The line clock ticks are sent along: a beat (counted on past the song loop, so the clock never
 * jumps when the song wraps) at a time in ms, and a tempo. `take` hands out the times of the
 * ticks not yet sent, up to a horizon, for scheduling ahead.
 */
export class ClockLine {
  /** Index of the next tick to send (tick n falls on beat n / 24). */
  next: number;
  private lastTime = -Infinity;
  private beat: number;
  private time: number;
  private bpm: number;

  constructor(beat: number, time: number, bpm: number) {
    this.beat = beat;
    this.time = time;
    this.bpm = bpm;
    this.next = Math.ceil(beat * PPQN - 1e-6);
  }

  beatAt(time: number): number {
    return this.beat + ((time - this.time) * this.bpm) / 60000;
  }

  timeOf(beat: number): number {
    return this.time + ((beat - this.beat) * 60000) / this.bpm;
  }

  /** Times of the ticks due before `until`, in order; never earlier than a tick already sent. */
  take(until: number): number[] {
    const out: number[] = [];
    for (;;) {
      const t = Math.max(this.timeOf(this.next / PPQN), this.lastTime);
      if (t >= until) break;
      out.push(t);
      this.lastTime = t;
      this.next++;
    }
    return out;
  }

  /** Bends the line through a new point and tempo; ticks already sent stay sent. */
  reanchor(beat: number, time: number, bpm: number) {
    this.beat = beat;
    this.time = time;
    this.bpm = bpm;
  }
}

/** A gap this long (ms) between ticks means the clock paused: start the estimate afresh. */
const GAP_MS = 250;
/** Ticks this far off the typical interval are dropped (a hiccup, not a tempo change). */
const OUTLIER = 1.6;
/** …unless this many arrive in a row: then the tempo really has moved. */
const OUTLIER_RUN = 6;
/** Intervals needed before there's an estimate. */
const MIN_INTERVALS = 6;

/** Tempo from incoming clock ticks: the mean of the last `size` intervals, outliers dropped. */
export class TempoEstimator {
  private intervals: number[] = [];
  private last: number | null = null;
  private outliers = 0;
  private readonly size: number;

  constructor(size = 48) {
    this.size = size;
  }

  /** A tick arrived at `time` (ms). */
  push(time: number) {
    const last = this.last;
    this.last = time;
    if (last === null) return;
    const dt = time - last;
    if (dt <= 0) return;
    if (dt > GAP_MS) return this.reset(time);
    if (this.intervals.length >= MIN_INTERVALS) {
      const typical = median(this.intervals);
      if (dt > typical * OUTLIER || dt < typical / OUTLIER) {
        if (++this.outliers < OUTLIER_RUN) return;
        this.intervals = []; // a run of them: a new tempo
      }
    }
    this.outliers = 0;
    this.intervals.push(dt);
    if (this.intervals.length > this.size) this.intervals.shift();
  }

  /** Forget everything (the clock stopped), keeping `time` as the last tick if given. */
  reset(time: number | null = null) {
    this.intervals = [];
    this.outliers = 0;
    this.last = time;
  }

  /** Estimated tempo in BPM, or null until enough ticks have come in. */
  bpm(): number | null {
    if (this.intervals.length < MIN_INTERVALS) return null;
    const mean = this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
    return 60000 / (mean * PPQN);
  }
}

/** Whether a new tempo estimate is worth re-anchoring the song clock for. */
export const tempoMoved = (current: number, estimate: number, threshold = 0.5) =>
  Math.abs(estimate - current) > threshold;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** MIDI sync settings, kept in the browser. Port choices are names; '' means every port. */
export interface MidiSettings {
  /** Send clock to `output`. */
  clockOut: boolean;
  output: string;
  /** INTERNAL runs on the song's own tempo; EXTERNAL follows clock from `input`. */
  sync: 'internal' | 'external';
  input: string;
}

export const DEFAULT_MIDI_SETTINGS: MidiSettings = {
  clockOut: false,
  output: '',
  sync: 'internal',
  input: '',
};

/** Settings from storage, with anything missing or damaged put back to the default. */
export function parseMidiSettings(raw: unknown): MidiSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof MidiSettings, unknown>
  >;
  return {
    clockOut: r.clockOut === true,
    output: typeof r.output === 'string' ? r.output : '',
    sync: r.sync === 'external' ? 'external' : 'internal',
    input: typeof r.input === 'string' ? r.input : '',
  };
}
