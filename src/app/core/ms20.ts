// MS-20 maths: front-panel knob positions → the units the circuits work in. Ranges follow
// the service manual's specification page (filters 50 Hz–15 kHz, EG times up to 10 s, EG2 hold
// up to 20 s, MG 0.1–20 Hz, VCO2 pitch ±1 octave, master tune ±100 cents).

import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

export type Vco1Wave = 'triangle' | 'sawtooth' | 'pulse' | 'noise';
export type Vco2Wave = 'sawtooth' | 'square' | 'narrow' | 'ring';
const VCO1_WAVES: Vco1Wave[] = ['triangle', 'sawtooth', 'pulse', 'noise'];
const VCO2_WAVES: Vco2Wave[] = ['sawtooth', 'square', 'narrow', 'ring'];
/** Footage → frequency ratio against 8'. VCO1 runs 32'–4', VCO2 16'–2'. */
const VCO1_FEET = [0.25, 0.5, 1, 2];
const VCO2_FEET = [0.5, 1, 2, 4];
/** VCO2's narrow pulse, as a duty cycle. */
export const NARROW_DUTY = 0.12;

/** A centre-detented knob as -1…+1. */
export const bipolar = (v: number) => v * 2 - 1;
/** Signed square law: fine control near the centre detent, full swing at the ends. */
const signedSq = (v: number) => Math.sign(v) * v * v;
/** An EG / hold time knob: fully left is "off", not a few milliseconds. */
const time = (v: number, max: number) => (v < 0.01 ? 0 : expMap(v, 0.002, max));

export function ms20Settings(p: Params) {
  return {
    vco1Wave: VCO1_WAVES[stepIndex(p['vco1Wave'], 4)],
    /** PW 1:1 (square) to nearly 1:∞ (a thin needle). */
    vco1Duty: 0.5 - p['vco1Pw'] * 0.47,
    vco1Ratio: VCO1_FEET[stepIndex(p['vco1Scale'], 4)],
    vco2Wave: VCO2_WAVES[stepIndex(p['vco2Wave'], 4)],
    vco2Ratio: VCO2_FEET[stepIndex(p['vco2Scale'], 4)],
    /** VCO2 PITCH, in cents (±1 octave). */
    vco2Cents: bipolar(p['vco2Pitch']) * 1200,
    tuneCents: bipolar(p['tune']) * 100,
    /** Portamento as a glide time constant in seconds (0 = jump). */
    portamento: time(p['portamento'], 1.5),
    /** Pitch modulation depths in cents. */
    fmMgCents: signedSq(bipolar(p['fmMg'])) * 1200,
    fmEg1Cents: p['fmEg1'] * p['fmEg1'] * 2400,
    vco1Level: p['vco1Level'],
    vco2Level: p['vco2Level'],
    hpfCutoff: expMap(p['hpfCutoff'], 50, 15000),
    lpfCutoff: expMap(p['lpfCutoff'], 50, 15000),
    /** PEAK runs from flat to self-oscillation. */
    hpfQ: peakQ(p['hpfPeak']),
    lpfQ: peakQ(p['lpfPeak']),
    /** Filter modulation depths in cents (MG ±4 octaves, EG2 ±6 octaves). */
    hpfMgCents: signedSq(bipolar(p['hpfMg'])) * 4800,
    lpfMgCents: signedSq(bipolar(p['lpfMg'])) * 4800,
    hpfEg2Cents: bipolar(p['hpfEg2']) * Math.abs(bipolar(p['hpfEg2'])) * 7200,
    lpfEg2Cents: bipolar(p['lpfEg2']) * Math.abs(bipolar(p['lpfEg2'])) * 7200,
    /** MG shape: 0 = falling ramp, 0.5 = triangle, 1 = rising ramp. */
    mgSkew: p['mgWave'],
    mgFreq: expMap(p['mgFreq'], 0.1, 20),
    eg1: {
      delay: time(p['eg1Delay'], 10),
      attack: time(p['eg1Attack'], 10),
      release: time(p['eg1Release'], 10),
    },
    eg2: {
      hold: time(p['eg2Hold'], 20),
      attack: time(p['eg2Attack'], 10),
      decay: time(p['eg2Decay'], 10),
      sustain: p['eg2Sustain'],
      release: time(p['eg2Release'], 10),
    },
    volume: p['volume'] * p['volume'],
  };
}

export type Ms20Settings = ReturnType<typeof ms20Settings>;

const peakQ = (v: number) => 0.6 + Math.pow(v, 2) * 34;

/**
 * One cycle of the MG's triangle output, skewed by the WAVE FORM knob: a falling ramp, through a
 * symmetric triangle, to a rising ramp. Starts at its low point.
 */
export function mgSamples(skew: number, n = 512) {
  const peak = Math.min(0.995, Math.max(0.005, skew));
  return Float32Array.from({ length: n }, (_, i) => {
    const t = i / n;
    return t < peak ? -1 + (2 * t) / peak : 1 - (2 * (t - peak)) / (1 - peak);
  });
}
