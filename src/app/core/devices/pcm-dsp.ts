// Shared maths for the PCM-70 and PCM-80 multi-effects: generated room impulses for the reverb
// algorithms, tuned comb resonators for the resonant-chord algorithms, tempo arithmetic for the
// BPM programs, and the tap networks behind the delay / chorus algorithms. Pure TypeScript, so
// `node --test` can check it (tests/pcm70.test.ts, tests/pcm80.test.ts).

import { faderGain } from '../sound.ts';

/** Deterministic noise (xorshift32), so a patch always sounds the same. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

/** One-pole low-pass coefficient for a corner frequency. */
const onePole = (hz: number, rate: number) => 1 - Math.exp((-2 * Math.PI * hz) / rate);

/** Amplitude after `t` seconds of a decay that falls 60 dB in `rt` seconds. */
export const decayEnv = (t: number, rt: number) => Math.exp((-6.9078 * t) / rt);

export type RoomShape = 'hall' | 'chamber' | 'plate' | 'inverse';

export interface RoomSpec {
  shape: RoomShape;
  /** Mid-frequency decay time (RT60) in seconds; for `inverse`, the length of the room. */
  rt: number;
  /** Bass decay as a multiple of `rt` (below the 250 Hz crossover). */
  bassMult: number;
  /** Above this, the tail decays faster (treble decay). */
  trebleHz: number;
  /** Room size in metres: spaces the early reflections and slows the build-up. */
  size: number;
  /** `inverse`: how many dB the envelope climbs over the length (6…36). */
  slope?: number;
}

/** Longest impulse we build, in seconds (a 12 s tail is already a cathedral). */
export const MAX_IR_SECONDS = 12;

export const irSeconds = (r: RoomSpec) =>
  r.shape === 'inverse' ? r.rt : Math.min(MAX_IR_SECONDS, r.rt * 1.3 + 0.05);

/**
 * A stereo room impulse. The late tail is decorrelated noise in three bands (bass below 250 Hz
 * decaying at `rt × bassMult`, mids at `rt`, treble above `trebleHz` at `rt × 0.35`, or `0.6` for
 * the brighter plate), after a build-up whose length grows with the room. Halls and chambers add
 * sparse early reflections spaced by the room size; the plate has none and builds up at once; the
 * inverse room climbs instead of decaying and stops dead at its length.
 */
export function roomImpulse(r: RoomSpec, rate: number, seed = 7): Float32Array<ArrayBuffer>[] {
  const n = Math.max(1, Math.floor(irSeconds(r) * rate));
  const aBass = onePole(250, rate);
  const aTreble = onePole(r.trebleHz, rate);
  const trebleRt = r.rt * (r.shape === 'plate' ? 0.6 : 0.35);
  const bassRt = r.rt * r.bassMult;
  // Time for sound to cross the room and back, roughly: sets the build-up and reflection spacing.
  const cross = r.size / 343;
  const buildUp = r.shape === 'plate' ? 0.002 : r.shape === 'chamber' ? cross * 0.5 : cross * 1.2;
  // Envelopes advance by a constant factor per sample (cheaper than exp() every sample).
  const step = (seconds: number) => decayEnv(1 / rate, seconds);
  const kBass = step(bassRt);
  const kMid = step(r.rt);
  const kTreble = step(trebleRt);
  const kAttack = Math.exp(-1 / (rate * Math.max(buildUp, 1e-4)));
  const kClimb = Math.pow(10, (r.slope ?? 24) / 20 / (r.rt * rate));
  return [0, 1].map((ch) => {
    const rand = rng(seed * 2 + ch + 1);
    const out = new Float32Array(n);
    let bass = 0;
    let mid = 0;
    let [eBass, eMid, eTreble, eAttack] = [1, 1, 1, 1];
    let climb = Math.pow(10, -(r.slope ?? 24) / 20);
    for (let i = 0; i < n; i++) {
      const w = rand();
      bass += aBass * (w - bass);
      const rest = w - bass;
      mid += aTreble * (rest - mid);
      const treble = rest - mid;
      if (r.shape === 'inverse') {
        const cut = Math.min(1, (n - i) / (0.004 * rate)); // a 4 ms fade, so the stop doesn't click
        out[i] = (bass + mid + treble * 0.7) * climb * cut;
        climb *= kClimb;
      } else {
        out[i] = (1 - eAttack) * (bass * eBass + mid * eMid + treble * eTreble);
        eBass *= kBass;
        eMid *= kMid;
        eTreble *= kTreble;
        eAttack *= kAttack;
      }
    }
    if (r.shape === 'hall' || r.shape === 'chamber') {
      // Early reflections: a dozen taps over the first crossings of the room, alternating sign.
      const span = r.shape === 'hall' ? cross * 3 : cross * 1.5;
      for (let k = 0; k < 12; k++) {
        const t = 0.003 + span * Math.pow((k + 0.5 + rand() * 0.5) / 12, 1.3);
        const i = Math.floor(t * rate);
        if (i < n) out[i] += (k % 2 ? -1 : 1) * 0.5 * decayEnv(t, r.rt) * (1 - k / 16);
      }
    }
    return normalise(out);
  });
}

/** Scales an impulse to a fixed energy, so long and short rooms come back at a similar level. */
export function normalise(x: Float32Array<ArrayBuffer>, energy = 0.5) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const g = sum > 0 ? Math.sqrt(energy / sum) : 0;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** A short diffusion burst: dense noise between 4 and 20 ms, the smear PCM-70 DIFFUSION adds. */
export function diffusionBurst(rate: number, seed = 3): Float32Array<ArrayBuffer>[] {
  const from = Math.floor(0.004 * rate);
  const to = Math.floor(0.02 * rate);
  return [0, 1].map((ch) => {
    const rand = rng(seed + ch);
    const x = new Float32Array(to);
    for (let i = from; i < to; i++) x[i] = rand() * decayEnv((i - from) / rate, 0.03);
    return normalise(x, 1);
  });
}

// --- Tempo --------------------------------------------------------------------------------------

/** Note values for the tempo-locked delays, in beats (quarter notes). */
export const NOTE_VALUES = [
  { name: '1/16', beats: 0.25 },
  { name: '1/8T', beats: 1 / 3 },
  { name: '1/8', beats: 0.5 },
  { name: '1/8.', beats: 0.75 },
  { name: '1/4', beats: 1 },
  { name: '1/4.', beats: 1.5 },
  { name: '1/2', beats: 2 },
];

export const beatSeconds = (bpm: number, beats = 1) => (60 / bpm) * beats;

/** A 0–1 knob over a tempo range, in whole BPM. */
export const knobBpm = (v: number, min = 40, max = 240) => Math.round(min + v * (max - min));

/** A 0–1 knob over a list: the position it points at. */
export const pick = <T>(v: number, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.max(0, Math.round(v * (list.length - 1))))];

// --- Tap networks (chorus, flange, echoes, multiband delays) -------------------------------------

export interface Tap {
  /** Delay in seconds. */
  time: number;
  /** -1 (left) … +1 (right). */
  pan: number;
  /** LFO phase, 0–1 of a cycle. */
  phase: number;
  /** Band-pass centre on the tap's output (multiband delays); 0 = full range. */
  band: number;
  /** How much of the input goes in (cascades and ping-pong feed only the first tap). */
  send: number;
}

export interface Link {
  from: number;
  to: number;
  /** Scaled by FEEDBACK (closing a loop) or a fixed unity link (a cascade stage). */
  feedback: boolean;
}

export type Topology = 'self' | 'ring' | 'cascade';

/** Which taps feed which: every tap is fed by at most one link. */
export function links(topology: Topology, n: number): Link[] {
  const r = Array.from({ length: n }, (_, i) => i);
  switch (topology) {
    case 'self':
      return r.map((i) => ({ from: i, to: i, feedback: true }));
    case 'ring':
      return r.map((i) => ({ from: i, to: (i + 1) % n, feedback: true }));
    case 'cascade':
      return r.map((i) => ({ from: i, to: (i + 1) % n, feedback: i === n - 1 }));
  }
}

/**
 * The largest gain any loop in the network can have: the product of the link gains round each
 * cycle. Every cycle must pass through a FEEDBACK link, so with |feedback| < 1 it stays bounded.
 */
export function loopGain(ls: Link[], feedback: number): number {
  let worst = 0;
  for (const start of new Set(ls.map((l) => l.from))) {
    let node = start;
    let g = 1;
    for (let steps = 0; steps <= ls.length; steps++) {
      const l = ls.find((x) => x.from === node);
      if (!l) break;
      g *= l.feedback ? Math.abs(feedback) : 1;
      node = l.to;
      if (node === start) {
        worst = Math.max(worst, g);
        break;
      }
    }
  }
  return worst;
}

// --- Resonant chords ----------------------------------------------------------------------------

export const CHORDS = [
  { name: 'MAJ', steps: [0, 4, 7, 12, 16, 19] },
  { name: 'MIN', steps: [0, 3, 7, 12, 15, 19] },
  { name: 'SUS4', steps: [0, 5, 7, 12, 17, 19] },
  { name: 'MAJ7', steps: [0, 4, 7, 11, 14, 19] },
  { name: 'MIN7', steps: [0, 3, 7, 10, 14, 19] },
  { name: 'DOM9', steps: [0, 4, 10, 14, 16, 19] },
  { name: '5THS', steps: [0, 7, 12, 19, 24, 31] },
];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteLabel = (n: number) => `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
export const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * Web Audio won't delay a loop by less than one 128-sample render quantum, so a comb can't ring
 * above about `rate / 128` Hz (≈ 344 Hz at 44.1 kHz). Chord tones the combs can't reach drop by
 * octaves: the chord keeps its pitch classes, only the voicing closes up.
 */
export const minLoopDelay = (rate: number) => 130 / rate;

export function chordHz(root: number, steps: number[], rate: number, toneHz = Infinity): number[] {
  return steps.map((s) => {
    let f = midiHz(root + s);
    while (combDelay(f, toneHz) < minLoopDelay(rate)) f /= 2;
    return f;
  });
}

/** Comb feedback for a ring that dies away 60 dB in `seconds` with this period. */
export const combFeedback = (period: number, seconds: number) =>
  Math.min(0.998, Math.pow(10, (-3 * period) / Math.max(seconds, period)));

/**
 * Phase delay of the loop's 2-pole low-pass (Butterworth) at `hz`: the comb's delay is shortened by
 * this much so the filter doesn't pull the note flat.
 */
export function lowpassDelay(hz: number, cornerHz: number) {
  const x = hz / cornerHz;
  return Math.atan2(Math.SQRT2 * x, 1 - x * x) / (2 * Math.PI * hz);
}

/** A comb tuned to `hz` through a `cornerHz` low-pass: the DelayNode time to set. */
export const combDelay = (hz: number, cornerHz: number) => 1 / hz - lowpassDelay(hz, cornerHz);

// --- What the audio engines take (see audio/devices/pcm-engines.ts) ---------------------------

export interface ReverbSettings {
  room: RoomSpec;
  /** Pre-delay before the room, in seconds. */
  predelay: number;
  /** Chorus on the tail ("spin"): delay excursion in seconds, and rate in Hz. */
  depth: number;
  rate: number;
  /** Tempo echoes fed into the room (PCM-80 Concert Hall): tap time, level, regeneration. */
  echo?: { time: number; level: number; feedback: number };
}

export interface TapSettings {
  taps: Tap[];
  topology: Topology;
  /** Loop gain per FEEDBACK link, -0.95…+0.95 (negative inverts, for a hollow flange). */
  feedback: number;
  /** Low-pass in every loop. */
  toneHz: number;
  /** LFO excursion of every tap in seconds, and its rate in Hz. */
  depth: number;
  rate: number;
  /** 0–1: how much of the input is smeared through the 4–20 ms diffuser first. */
  diffusion: number;
  /** Q of the multiband taps' band-pass filters (default 1.4). */
  bandQ?: number;
}

export interface ChordSettings {
  /** Root as a MIDI note, and the chord's steps above it (one comb per step). */
  root: number;
  steps: number[];
  /** Ring time (60 dB) in seconds. */
  decay: number;
  /** Low-pass in each comb loop: lower is darker and dies faster up top. */
  toneHz: number;
  /** Spread of the voices: ± cents of detune, stereo width 0–1, strum delay per voice (s). */
  detune: number;
  width: number;
  strum: number;
}

/** Text helpers for the 2-line displays. INPUT / OUTPUT knobs read as dB (0.7 ≈ unity). */
export const fmtDb = (v: number) => {
  const g = faderGain(v);
  return g <= 0 ? '-INF' : `${(20 * Math.log10(g)).toFixed(1)}DB`;
};
export const fmtTime = (s: number) =>
  s < 0.9995 ? `${Math.round(s * 1000)}MS` : `${s.toFixed(s < 9.95 ? 2 : 1)}S`;
export const fmtHz = (hz: number) =>
  hz >= 1000 ? `${(hz / 1000).toFixed(1)}K` : `${Math.round(hz)}`;
export const pct = (v: number) => `${Math.round(v * 100)}%`;
