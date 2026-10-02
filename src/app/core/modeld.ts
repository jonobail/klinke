// Model D maths: front-panel positions → circuit units. Layout and signal flow follow the service
// manual (front panel fig. 7-1, block diagram dwg. 1429, left-hand controller fig. 9-12). The
// manual is a repair guide and doesn't print most ranges; the ones marked † below are the
// published figures for the instrument, the rest are our interpretation.

import { expMap } from './sound.ts';
import { pulseSamples, stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** RANGE switch, LO then 32'–2', as a ratio against 8'. LO puts an oscillator in LFO territory. */
const RANGE_RATIO = [1 / 64, 0.25, 0.5, 1, 2, 4];

export type ModelDWave =
  'triangle' | 'trisaw' | 'sawtooth' | 'revsaw' | 'square' | 'wide' | 'narrow';
const OSC_WAVES: ModelDWave[] = ['triangle', 'trisaw', 'sawtooth', 'square', 'wide', 'narrow'];
const OSC3_WAVES: ModelDWave[] = ['triangle', 'revsaw', 'sawtooth', 'square', 'wide', 'narrow'];

/** Pitch wheel range in semitones each way. */
export const BEND_SEMITONES = 5;
/** Full mod wheel depth: pitch (cents) and filter cutoff (cents). */
export const OSC_MOD_CENTS = 1200;
export const FILTER_MOD_CENTS = 3600;

const bipolar = (v: number) => v * 2 - 1;
const on = (v: number) => v >= 0.5;

export function modelDSettings(p: Params) {
  const contour = (a: string, d: string, s: string) => ({
    attack: expMap(p[a], 0.001, 10), // † 1 ms–10 s
    decay: expMap(p[d], 0.004, 35), // † 4 ms–35 s
    sustain: p[s],
  });
  return {
    tuneCents: bipolar(p['tune']) * 200,
    /** Glide as a time constant in seconds, only while the GLIDE switch is on. */
    glide: on(p['glideOn']) ? expMap(p['glide'], 0.002, 3) : 0,
    /** 0 = all oscillator 3, 1 = all noise (the MODULATION MIX pan). */
    modMix: p['modMix'],
    modWheel: p['modWheel'],
    oscMod: on(p['oscMod']),
    filterMod: on(p['filterMod']),
    /** OSC 3 CONTROL: oscillator 3 follows the keyboard (off = free-running, e.g. as an LFO). */
    osc3Kbd: on(p['osc3Kbd']),
    osc: [1, 2, 3].map((n) => ({
      ratio: RANGE_RATIO[stepIndex(p[`osc${n}Range`], 6)],
      wave: (n === 3 ? OSC3_WAVES : OSC_WAVES)[stepIndex(p[`osc${n}Wave`], 6)],
      /** FREQUENCY knob on 2 and 3, ±7 semitones †. */
      cents: n === 1 ? 0 : bipolar(p[`osc${n}Freq`]) * 700,
      level: on(p[`osc${n}On`]) ? p[`osc${n}Vol`] : 0,
    })),
    extLevel: on(p['extOn']) ? p['extVol'] * p['extVol'] * 2 : 0, // audio-taper pot (R9)
    noiseLevel: on(p['noiseOn']) ? p['noiseVol'] : 0,
    noisePink: on(p['noisePink']),
    /** KEYBOARD CONTROL 1 and 2 add 1/3 and 2/3 of the keyboard voltage to the filter. */
    kbdTrack: (on(p['kbd1']) ? 1 / 3 : 0) + (on(p['kbd2']) ? 2 / 3 : 0),
    cutoff: expMap(p['cutoff'], 15, 15000),
    /** EMPHASIS → resonance of the 24 dB ladder's last stage, up to the edge of oscillation. */
    emphasisQ: 0.5 + p['emphasis'] * p['emphasis'] * 28,
    /** AMOUNT OF CONTOUR, in cents of cutoff sweep (up to 4 octaves). */
    contourCents: p['contour'] * 4800,
    filter: contour('fAttack', 'fDecay', 'fSustain'),
    loudness: contour('lAttack', 'lDecay', 'lSustain'),
    /** DECAY switch on: releasing a key lets the contours fall at the DECAY rate; off: they stop. */
    decayOn: on(p['decayOn']),
    volume: on(p['mainOn']) ? p['volume'] * p['volume'] : 0,
    a440: on(p['a440']),
  };
}

export type ModelDSettings = ReturnType<typeof modelDSettings>;

/** One cycle of each Model D waveform. Sawtooth rises, reverse sawtooth falls. */
export function modelDSamples(wave: ModelDWave, n = 1024): Float32Array {
  const ramp = (i: number) => (2 * i) / n - 1;
  const tri = (i: number) => (i < n / 2 ? (4 * i) / n - 1 : 3 - (4 * i) / n);
  switch (wave) {
    case 'triangle':
      return Float32Array.from({ length: n }, (_, i) => tri(i));
    case 'trisaw': // the "shark tooth" between triangle and sawtooth
      return Float32Array.from({ length: n }, (_, i) => (tri(i) + ramp(i)) / 2);
    case 'sawtooth':
      return Float32Array.from({ length: n }, (_, i) => ramp(i));
    case 'revsaw':
      return Float32Array.from({ length: n }, (_, i) => -ramp(i));
    case 'square':
      return pulseSamples(0.5, n);
    case 'wide':
      return pulseSamples(0.3, n);
    case 'narrow':
      return pulseSamples(0.12, n);
  }
}
