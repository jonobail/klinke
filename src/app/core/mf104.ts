// MF-104 analog delay maths, after the schematics (BRD-10-011-360 sheets 1–2, daughterboard
// BRD-10-011-365). The signal runs DRIVE preamp → anti-alias filter → compander → bucket-brigade
// delay line → reconstruction filter → expander → MIX crossfade, with FEEDBACK (or the external
// LOOP) back into the delay line.

import { expMap, mixSends } from './sound.ts';

type Params = Record<string, number>;

/** Unity-gain Sallen–Key low-pass corner frequency from its parts, in Hz. */
export const sallenKey = (r1: number, r2: number, c1: number, c2: number) =>
  1 / (2 * Math.PI * Math.sqrt(r1 * r2 * c1 * c2));

/**
 * The anti-alias / reconstruction filters. Sheet 2 has two sets, chosen by the RANGE switch
 * (SW2 through the CD4016 switches): 22k / 47k with 12 nF / 270 pF for the short range, and
 * 22k / 47k with 27 nF / 560 pF for the long range, where the slower clock needs a lower corner.
 */
export const FILTER_HZ = {
  short: sallenKey(22e3, 47e3, 12e-9, 270e-12), // ≈ 2.7 kHz
  long: sallenKey(22e3, 47e3, 27e-9, 560e-12), // ≈ 1.3 kHz
};

/** The Z board's delay line: two MN3005s of 4096 stages each. */
export const BBD_STAGES = 2 * 4096;
/** A bucket-brigade line delays by stages / (2 × clock). */
export const bbdClock = (seconds: number) => BBD_STAGES / (2 * seconds);

/**
 * TIME range in seconds. SW2 puts a second 3300 pF timing capacitor (C43) beside C55 on the clock
 * VCO, halving the clock, so LONG is exactly twice SHORT. The end points are our interpretation:
 * the schematics don't print them.
 */
const SHORT = [0.04, 0.4] as const;

export function mf104Settings(p: Params) {
  const long = p['range'] >= 0.5;
  const span = long ? 2 : 1;
  return {
    long,
    /** Preamp gain into the delay; past about ×4 the input starts to clip (the DRIVE LED goes red). */
    drive: expMap(p['drive'], 0.5, 16),
    seconds: expMap(p['time'], SHORT[0], SHORT[1]) * span,
    /** Loop gain; the top of the knob passes unity, so repeats build into runaway oscillation. */
    feedback: p['feedback'] * 1.1,
    ...mixSends(p['mix']),
    output: Math.pow(p['output'] / 0.7, 2),
    /** EXT LOOP: the delay's LOOP OUT goes round an outside effect and back via LOOP IN. */
    extLoop: p['loop'] >= 0.5,
    loopGain: p['loopGain'] * 2,
    filterHz: long ? FILTER_HZ.long : FILTER_HZ.short,
    bypass: p['bypass'] >= 0.5,
  };
}

export type Mf104Settings = ReturnType<typeof mf104Settings>;

/**
 * Soft clipping for the preamp and the delay loop: tanh, with unity gain for small signals so it
 * never adds loop gain of its own. A WaveShaper reads its curve over -1…+1, so the signal is scaled
 * down by `HEADROOM` on the way in; the curve covers ±HEADROOM of real signal.
 */
export const HEADROOM = 4;
export const softClipCurve = (n = 2049): Float32Array<ArrayBuffer> =>
  Float32Array.from({ length: n }, (_, i) => Math.tanh(HEADROOM * ((2 * i) / (n - 1) - 1)));
