// SH-101 maths, after the service notes (Nov. 1982): specifications and top view p.1, block
// diagram p.2, CPU program pp.3–4 (key assigner, arpeggio, sequencer, clocked by the LFO).

import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** RANGE 16'–2' against 8'. */
const RANGE_RATIO = [0.5, 1, 2, 4];
/** TRANSPOSE L / M / H. */
const TRANSPOSE = [-12, 0, 12];

export type LfoWave = 'triangle' | 'square' | 'random' | 'noise';
const LFO_WAVES: LfoWave[] = ['triangle', 'square', 'random', 'noise'];
export type SubMode = 'oct1' | 'oct2' | 'pulse2';
const SUB_MODES: SubMode[] = ['oct1', 'oct2', 'pulse2'];
export type PwmSource = 'lfo' | 'man' | 'env';
const PWM_SOURCES: PwmSource[] = ['lfo', 'man', 'env'];
export type EnvTrigger = 'gateTrig' | 'gate' | 'lfo';
const ENV_TRIGGERS: EnvTrigger[] = ['gateTrig', 'gate', 'lfo'];
export type Arp = 'off' | 'up' | 'updown' | 'down';
const ARPS: Arp[] = ['off', 'up', 'updown', 'down'];
export type SeqMode = 'off' | 'load' | 'play';
const SEQ_MODES: SeqMode[] = ['off', 'load', 'play'];
export type Portamento = 'off' | 'on' | 'auto';
const PORTAMENTOS: Portamento[] = ['off', 'on', 'auto'];

export const SEQ_STEPS = 100;

/** Time knob → seconds, with fully left at the spec's minimum. */
const time = (v: number, min: number, max: number) => expMap(v, min, max);

export function sh101Settings(p: Params) {
  return {
    lfoRate: expMap(p['lfoRate'], 0.1, 30), // MODULATOR RATE, 0.1–30 Hz (spec)
    lfoWave: LFO_WAVES[stepIndex(p['lfoWave'], 4)],
    /** VCO MOD (vibrato depth), up to ±1 octave in cents. */
    vcoMod: p['vcoMod'] * p['vcoMod'] * 1200,
    ratio: RANGE_RATIO[stepIndex(p['range'], 4)],
    transpose: TRANSPOSE[stepIndex(p['transpose'], 3)],
    tuneCents: (p['tune'] * 2 - 1) * 50, // ±50 cent (spec)
    /** PULSE WIDTH 50 % → nearly 0 % (spec), as a duty cycle. */
    pulseWidth: 0.5 - p['pulseWidth'] * 0.47,
    pwmSource: PWM_SOURCES[stepIndex(p['pwmSource'], 3)],
    pulse: p['pulse'],
    saw: p['saw'],
    sub: p['sub'],
    subMode: SUB_MODES[stepIndex(p['subMode'], 3)],
    noise: p['noise'],
    cutoff: expMap(p['cutoff'], 10, 20000), // 10 Hz – 20 kHz (spec)
    /** RES up to the edge of self-oscillation; Web Audio Q is in dB. */
    resonance: p['resonance'] * p['resonance'] * 30,
    /** VCF ENV, MOD amounts in cents of cutoff; KYBD key follow 0–100 % (spec). */
    vcfEnv: p['vcfEnv'] * 6000,
    vcfMod: p['vcfMod'] * p['vcfMod'] * 3600,
    vcfKybd: p['vcfKybd'],
    vcaGate: p['vcaMode'] >= 0.5, // VCA: ENV (0) or GATE (1)
    attack: time(p['attack'], 0.0015, 4), // 1.5 ms – 4 s (spec)
    decay: time(p['decay'], 0.002, 10), // 2 ms – 10 s
    sustain: p['sustain'],
    release: time(p['release'], 0.002, 10), // 2 ms – 10 s
    envTrigger: ENV_TRIGGERS[stepIndex(p['envTrigger'], 3)],
    portamento: PORTAMENTOS[stepIndex(p['portaMode'], 3)],
    portaTime: p['portaTime'] < 0.01 ? 0 : time(p['portaTime'], 0.005, 5) / 4, // 0–5 s (spec)
    arp: ARPS[stepIndex(p['arp'], 4)],
    seq: SEQ_MODES[stepIndex(p['seq'], 3)],
    hold: p['hold'] >= 0.5,
    bendVco: p['bendVco'] * 1200, // bender to VCO: up to ±1 octave
    bendVcf: p['bendVcf'] * 4800,
    /** LFO MOD: vibrato depth added while the bender lever is pushed forward (cents). */
    lfoMod: (p['lfoMod'] ?? 0) * (p['lfoMod'] ?? 0) * 600,
    volume: p['volume'] * p['volume'],
  };
}

export type Sh101Settings = ReturnType<typeof sh101Settings>;

/**
 * PWM by comparator: a rising sawtooth (-1…+1) plus a bias, squared up, is high for
 * (1 + bias) / 2 of each cycle. So a duty cycle d needs a bias of 2d - 1.
 */
export const pwmBias = (duty: number) => 2 * duty - 1;

/** The comparator's transfer curve: a steep tanh so the edges stay just short of hard. */
export function comparatorCurve(n = 4097, steepness = 40): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: n }, (_, i) => Math.tanh(steepness * ((2 * i) / (n - 1) - 1)));
}

/**
 * Arpeggio order for the held keys (§11: "the order of the key numbers stored in the Arpeggio
 * Key Buffer"): UP lowest → highest, DOWN highest → lowest, U&D up then down without repeating
 * the end notes.
 */
export function arpeggio(held: number[], mode: Arp): number[] {
  const up = [...new Set(held)].sort((a, b) => a - b);
  if (mode === 'up') return up;
  if (mode === 'down') return up.slice().reverse();
  if (mode === 'updown') return up.length > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
  return [];
}

/** A sequencer step: a note number, or null for a rest (entered with the REST button). */
export type Step = number | null;

/** LOAD appends steps up to the 100-step memory (spec). */
export const loadStep = (seq: Step[], step: Step): Step[] =>
  seq.length >= SEQ_STEPS ? seq : [...seq, step];

/**
 * PLAY transposes the stored line by the key held (relative to the first note entered), the way
 * the KEY TRANSPOSE function works; with no key held it plays as entered.
 */
export function transposeSequence(seq: Step[], key: number | null): Step[] {
  const first = seq.find((s): s is number => s !== null);
  if (key === null || first === undefined) return seq;
  return seq.map((s) => (s === null ? null : s + key - first));
}
