// H949 harmonizer, after the service manual (technical section, pages "T…") and the schematics
// (pages "S…"):
//   T6   input: INPUT LEVEL, summed with FEEDBACK, 7-pole low-pass, 2:1 compressor, ADC; two
//        outputs (MAIN and DELAY ONLY), each with its own DAC, low-pass and expander. LINE switch
//        OUT = straight through.
//   T7   pitch change: writing at the 41 kHz sampling rate, reading at 10.25–82 kHz (pitch ratio
//        0.25–2, "two octaves down, one up"), splicing between two read pointers OUTA and OUTB;
//        two splicing ALGORITHMs. VCO linear over the MANUAL pot's range.
//   T9–T11 µPC#, µPCb, FLANGE and RANDOM use the single-sideband generator instead: ratio
//        1 ± f / 82 kHz, with f 20 Hz–6 kHz (µPC: 0.93–1.07) or 20–600 Hz (FLANGE / RANDOM:
//        0.993–1.007). FLANGE sweeps the delay between 7.5 and 17.5 ms and adds a fixed 12.5 ms;
//        RANDOM random-walks it between 2.5 and 22.5 ms, steered by a noise generator at 820 Hz.
//   T16  the pitch-change pointer covers 0–25 ms.
//   T17  11 × 16K RAM: 16384 samples (0.4 s at 41 kHz); REPEAT stops writing, so the memory loops.
//   T18  FIXED DELAY: the MAIN DELAY SET switches (+ 12.5 ms in FLANGE).
//   T20  DELAY SET: two banks of six push switches (S17: 6.25, 12.5, 25, 50, 100, 200 ms); in every
//        function but DELAY only the MAIN bank's 50 / 100 / 200 switches count. FEEDBACK: DLY FB
//        and MAIN FB pots summed, then an EQ LOW / EQ HI network (S17).
//   S18  FUNCTION: four interlocking switches + a FUNCTION push switch pick one of eight
//        (DELAY / NORM PC, RANDOM / EXTEND PC, FLANGE / µPC#, REVERSE / µPCb); ALGORITHM 1 / 2.

import { type GearDef, bi, p, rack, rocker, sel } from '../gear-types.ts';

type Params = Record<string, number>;

/** Sampling rate and memory (T7, T17). */
export const FS = 41e3;
export const MEMORY_SECONDS = 16384 / FS;

/** The DELAY SET push switches (S17), in ms. */
export const DELAY_SWITCHES = [6.25, 12.5, 25, 50, 100, 200] as const;
const STEP_MS = DELAY_SWITCHES[0];

/** Knob → switch bank pattern → ms: 0…393.75 ms in 6.25 ms steps. */
export const delaySetMs = (v: number) => Math.min(63, Math.floor(v * 64)) * STEP_MS;
/** Outside DELAY only the 50 / 100 / 200 ms switches of the MAIN bank are read (T20). */
export const coarseMs = (ms: number) => Math.floor(ms / 50) * 50;

/** FUNCTION positions, green bank first then red (S18). */
export const FUNCTIONS = [
  'DELAY',
  'RANDOM',
  'FLANGE',
  'REVERSE',
  'NORMAL',
  'EXTEND',
  'UPC#',
  'UPCB',
] as const;
export type H949Function = (typeof FUNCTIONS)[number];

/** Pitch ratio from the MANUAL pot through the linear VCO: 10.25–82 kHz read rate / 41 kHz (T7). */
export const vcoRatio = (v: number) => 0.25 + 1.75 * v;
/** Quadrature oscillator for the SSB modes: ~20 Hz–6 kHz (µPC) or 20–600 Hz (FLANGE, RANDOM). */
export const ssbHz = (v: number, fn: H949Function) =>
  fn === 'UPC#' || fn === 'UPCB' ? 20 + (6000 - 20) * v : 20 + (600 - 20) * v;
/** The SSB's carrier is FSYS = 82 kHz: the read clock runs at 82 kHz ± the oscillator. */
export const FSYS = 82e3;

/**
 * Splice window: the pointer swings 0–25 ms in the pitch-change modes (T10, T16). EXTEND and
 * REVERSE aren't described in these pages; we give them a doubled 50 ms window (interpretation).
 */
export const WINDOW = { normal: 0.025, extended: 0.05 } as const;

/** FLANGE sweep and fixed delay (T10, T18); RANDOM's limits (T10). */
export const FLANGE_MIN = 0.0075;
export const FLANGE_MAX = 0.0175;
export const FLANGE_FIXED = 0.0125;
export const RANDOM_MIN = 0.0025;
export const RANDOM_MAX = 0.0225;

/**
 * RANDOM: the hardware picks "delay up" or "delay down" at random 820 times a second (T11) and
 * reflects off the 2.5 / 22.5 ms limits. We use smoothed noise instead (a random walk filtered
 * into a bounded wander), centred on 12.5 ms, scaled so its rate of change roughly matches the
 * SSB's |1 − ratio| and its peaks stay inside the limits.
 */
export const RANDOM_NOISE_HZ = 1;
export const randomDepth = (slew: number) =>
  Math.min(slew / (2 * Math.PI * RANDOM_NOISE_HZ), (RANDOM_MAX - FLANGE_FIXED) / 3.5);

export function h949Settings(params: Params) {
  const fn = FUNCTIONS[Math.round(params['function'] * (FUNCTIONS.length - 1))];
  const mainMs = delaySetMs(params['mainDelay']);
  const dlyMs = delaySetMs(params['dlyDelay']);
  const manual = params['pitch'];
  const ssb = ssbHz(manual, fn);
  let ratio = vcoRatio(manual);
  if (fn === 'UPC#') ratio = 1 + ssb / FSYS;
  if (fn === 'UPCB') ratio = 1 - ssb / FSYS;
  const pitchMode =
    fn === 'NORMAL' || fn === 'EXTEND' || fn === 'REVERSE' || fn === 'UPC#' || fn === 'UPCB';
  const window = fn === 'EXTEND' || fn === 'REVERSE' ? WINDOW.extended : WINDOW.normal;
  // How fast the read pointer drifts through the window, in seconds of delay per second: reading
  // faster than writing shortens the delay (ratio > 1). REVERSE reads backwards, so the delay
  // grows by 1 + ratio every second.
  const drift = fn === 'REVERSE' ? 1 + ratio : 1 - ratio;
  const sweepSlew = ssb / FSYS; // FLANGE / RANDOM: |1 − ratio|
  const base = fn === 'DELAY' ? mainMs / 1000 : coarseMs(mainMs) / 1000;
  return {
    fn,
    pitchMode,
    /** Pitch ratio shown on the readout (the SSB modes show their sweep ratio). */
    ratio: fn === 'FLANGE' || fn === 'RANDOM' ? 1 + sweepSlew : ratio,
    window,
    /** Splice rate in Hz (cycles of the pointer through the window). */
    spliceHz: pitchMode ? Math.abs(drift) / window : 0,
    /** +1: the delay grows through each splice; −1: it shrinks. */
    direction: drift >= 0 ? 1 : -1,
    /** ALGORITHM 2: overlapping raised-cosine splices; ALGORITHM 1: quick switch-over. */
    algorithm: params['algorithm'] >= 0.5 ? 2 : 1,
    base,
    mainMs,
    dlyMs,
    dlySeconds: dlyMs / 1000,
    /** FLANGE: triangle between 7.5 and 17.5 ms with slope `sweepSlew`. */
    flangeHz: fn === 'FLANGE' ? sweepSlew / (2 * (FLANGE_MAX - FLANGE_MIN)) : 0,
    randomDepth: fn === 'RANDOM' ? randomDepth(sweepSlew) : 0,
    repeat: params['repeat'] >= 0.5,
    mainFb: params['mainFb'],
    dlyFb: params['dlyFb'],
    eqLowDb: (params['eqLow'] * 2 - 1) * 12,
    eqHighDb: (params['eqHigh'] * 2 - 1) * 12,
  };
}

export type H949Settings = ReturnType<typeof h949Settings>;

/**
 * OUTA's splice gain over one pointer cycle, phase φ ∈ [0, 1) (OUTA's position in the window;
 * OUTB is half a cycle away and gets 1 − this). ALGORITHM 2 crossfades continuously with raised
 * cosines (sin²); ALGORITHM 1 holds OUTA and hands over to OUTB only around OUTA's splice point,
 * fading across the first and last 10 % of the cycle. (The manual names the algorithms but
 * doesn't describe them; these two shapes are our interpretation.)
 */
export function spliceGain(phase: number, algorithm: 1 | 2) {
  const f = phase - Math.floor(phase);
  if (algorithm === 2) return Math.pow(Math.sin(Math.PI * f), 2);
  return Math.min(1, Math.min(f, 1 - f) / 0.1);
}

/** OUTB's phase, half a cycle on from OUTA's. */
export const phaseB = (phase: number) => {
  const f = phase + 0.5;
  return f - Math.floor(f);
};

/** WaveShaper curves over the ramp's −1…+1 (φ = (x + 1) / 2): gain A, gain B, and B's position. */
export function spliceCurves(algorithm: 1 | 2, n = 4097) {
  const at = (i: number) => i / (n - 1);
  const mk = (fx: (phi: number) => number) => Float32Array.from({ length: n }, (_, i) => fx(at(i)));
  return {
    gainA: mk((phi) => spliceGain(phi, algorithm)),
    gainB: mk((phi) => 1 - spliceGain(phi, algorithm)),
    /** OUTB's position, −1…+1 across the window, like the ramp is for OUTA. */
    posB: mk((phi) => 2 * phaseB(phi) - 1),
  };
}

/** A one-cycle rising ramp −1…+1 (played looped as the pointer). */
export const rampCycle = (n: number): Float32Array<ArrayBuffer> =>
  Float32Array.from({ length: n }, (_, i) => (2 * i) / n - 1);

/** Smoothed, unit-RMS noise (two one-pole low-passes at `hz`) for RANDOM, `rate` samples a second. */
export function wanderNoise(seconds: number, rate: number, hz = RANDOM_NOISE_HZ, seed = 0x949) {
  let s = seed >>> 0;
  const rnd = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.round(seconds * rate);
  const k = 1 - Math.exp((-2 * Math.PI * hz) / rate);
  const out = new Float32Array(n);
  let a = 0;
  let b = 0;
  // Two passes so the loop point is settled (the second pass starts where the first ended).
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      a += k * (rnd() * 2 - 1 - a);
      b += k * (a - b);
      out[i] = b;
    }
  }
  let mean = 0;
  for (const v of out) mean += v / n;
  let sq = 0;
  for (const v of out) sq += ((v - mean) * (v - mean)) / n;
  const rms = Math.sqrt(sq) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / rms;
  return out;
}

const fnText: Record<H949Function, string> = {
  DELAY: 'DELAY',
  RANDOM: 'RANDOM',
  FLANGE: 'FLANGE',
  REVERSE: 'REVERSE',
  NORMAL: 'NORM PC',
  EXTEND: 'EXT PC',
  'UPC#': 'uPC#',
  UPCB: 'uPCb',
};

export const h949: GearDef = rack({
  kind: 'h949',
  label: 'H949',
  subtitle: 'HARMONIZER',
  w: 18,
  h: 3,
  params: [
    p('input', 'INPUT', 0.75),
    rocker('repeat', 'REPEAT', 'white', false),
    p('mainFb', 'MAIN FB', 0),
    p('dlyFb', 'DLY FB', 0),
    bi('eqLow', 'EQ LOW'),
    bi('eqHigh', 'EQ HI'),
    p('dlyDelay', 'DLY ONLY', 16 / 64),
    sel(
      'function',
      'FUNC',
      FUNCTIONS.map((f) => fnText[f]),
      4,
    ),
    p('pitch', 'MANUAL', 1.25 / 1.75), // ratio 1.500, a fifth up
    rocker('algorithm', 'ALG 2', 'orange', true),
    p('mainDelay', 'MAIN', 0),
    p('mix', 'MIX', 0.5),
  ],
  sections: [
    { title: 'INPUT', rows: [['input', 'repeat']] },
    { title: 'FEEDBACK', rows: [['mainFb', 'dlyFb']] },
    { title: 'FB EQ', rows: [['eqLow', 'eqHigh']] },
    { title: 'DELAY ONLY', rows: [['dlyDelay']] },
    { title: 'PITCH', rows: [['function', 'pitch']] },
    { title: 'MAIN', rows: [['algorithm', 'mainDelay']] },
    { title: 'OUT', rows: [['mix']] },
  ],
  display: (params) => {
    const s = h949Settings(params);
    return `${s.ratio.toFixed(3)} ${fnText[s.fn]}\nM${Math.round(s.mainMs)} D${Math.round(s.dlyMs)}`;
  },
  jacks: [
    { id: 'in', dir: 'in', fx: 0.02, fy: 0.96 },
    { id: 'dly', dir: 'out', fx: 0.9, fy: 0.96, label: 'DLY ONLY' },
    { id: 'out', dir: 'out', fx: 0.98, fy: 0.96 },
  ],
  face: { panel: '#1f2024', text: '#d8d4c8', display: '#ff3a2a' },
});
