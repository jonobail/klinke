// SH-2 (1979): catalog entry and maths, after the service notes (Oct. 15, 1979): specifications
// p.1, block diagram p.2, parts list p.3, VCO / LFO board schematic (OPH61 / OPH62) p.4, board
// layouts pp.5–6, VCF / VCA / ADSR / KCV / bender schematic (OPH63 / OPH64 / OPH65) p.7.

import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';
import { type GearDef, bi, noteJacks, p, rocker, sel } from './gear-types.ts';

type Params = Record<string, number>;

/** RANGE 32'–2' (S7 for VCO-1, S4 for VCO-2) as a ratio against 8'. */
const RANGE_RATIO = [0.25, 0.5, 1, 2, 4];

/** VCO-1 WAVEFORM (S10): ∿, saw, square, pulse (the one PULSE WIDTH / PWM act on). */
export type Vco1Wave = 'sine' | 'saw' | 'square' | 'pulse';
const VCO1_WAVES: Vco1Wave[] = ['sine', 'saw', 'square', 'pulse'];
/** VCO-2 WAVEFORM (S6): NOISE, saw, square, narrow pulse. */
export type Vco2Wave = 'noise' | 'saw' | 'square' | 'pulse';
const VCO2_WAVES: Vco2Wave[] = ['noise', 'saw', 'square', 'pulse'];
/** MODULATOR MODE (S11): ∿, square, RANDOM (the noise sampled and held by the LFO). */
export type LfoWave = 'sine' | 'square' | 'random';
const LFO_WAVES: LfoWave[] = ['sine', 'square', 'random'];
/** PWM MODE (S9). */
export type PwmSource = 'lfo' | 'man' | 'env';
const PWM_SOURCES: PwmSource[] = ['lfo', 'man', 'env'];
/** VCF envelope switch (S3): ENV FOL'R, ENV (positive), ENV (inverted). */
export type VcfEnvSource = 'follower' | 'env' | 'inverted';
const VCF_ENV_SOURCES: VcfEnvSource[] = ['follower', 'env', 'inverted'];
/** VCA MODULATION SWITCH (S1): HOLD (open), ENV, GATE. */
export type VcaMode = 'hold' | 'env' | 'gate';
const VCA_MODES: VcaMode[] = ['hold', 'env', 'gate'];
/** ENV GATE SELECTOR (S2). */
export type EnvTrigger = 'gateTrig' | 'gate' | 'lfo';
const ENV_TRIGGERS: EnvTrigger[] = ['gateTrig', 'gate', 'lfo'];

/** VCO-2's pulse: the narrow fixed-width position of S6 (the width is our choice). */
export const VCO2_PULSE = 0.2;
/** AUTO BEND: how far above the note the pitch starts (our choice; the notes don't print it). */
export const AUTO_BEND_CENTS = 1200;

const bipolar = (v: number) => v * 2 - 1;

export function sh2Settings(v: Params) {
  const tuneWide = v['tuneRange'] < 0.5;
  return {
    lfoRate: expMap(v['lfoRate'], 0.2, 25), // RATE 0.2–25 Hz (spec)
    lfoDelay: v['lfoDelay'] * 1.5, // DELAY TIME 0–1.5 s (spec)
    lfoWave: LFO_WAVES[stepIndex(v['lfoWave'], 3)],
    /** VCO MOD (LFO into both VCOs), up to ±1 octave in cents. */
    vcoMod: v['vcoMod'] * v['vcoMod'] * 1200,
    /** AUTO BEND: the time constant of the swoop into each note (0 = off). */
    autoBend: v['autoBend'] < 0.01 ? 0 : v['autoBend'] * v['autoBend'] * 0.5,
    /** PULSE WIDTH 50 % → min (spec), as a duty cycle. */
    pulseWidth: 0.5 - v['pulseWidth'] * 0.45,
    pwmSource: PWM_SOURCES[stepIndex(v['pwmSource'], 3)],
    bendVco1: v['bendVco1'] >= 0.5, // VCO-1 BENDER ON / OFF (spec)
    ratio1: RANGE_RATIO[stepIndex(v['range1'], 5)],
    wave1: VCO1_WAVES[stepIndex(v['wave1'], 4)],
    ratio2: RANGE_RATIO[stepIndex(v['range2'], 5)],
    wave2: VCO2_WAVES[stepIndex(v['wave2'], 4)],
    /** VCO-2 TUNE: WIDE ±1 octave, NARROW ±1 semitone (our figures). */
    tune2Cents: bipolar(v['tune2']) * (tuneWide ? 1200 : 100),
    tuneCents: bipolar(v['tune']) * 100, // TOTAL TUNE, ±1 semitone (our figure)
    sub: v['sub'],
    vco1: v['vco1'],
    vco2: v['vco2'],
    cutoff: expMap(v['cutoff'], 10, 20000), // 10 Hz – 20 kHz (spec)
    /** RESONANCE up to self-oscillation (spec); Web Audio Q is in dB. */
    resonance: v['resonance'] * v['resonance'] * 32,
    vcfEnvSource: VCF_ENV_SOURCES[stepIndex(v['vcfEnvSource'], 3)],
    /** ENV, MOD amounts in cents of cutoff; KYBD key follow 0–100 %. */
    vcfEnv: v['vcfEnv'] * 6000,
    vcfMod: v['vcfMod'] * v['vcfMod'] * 3600,
    vcfKybd: v['vcfKybd'],
    vcaMode: VCA_MODES[stepIndex(v['vcaMode'], 3)],
    attack: expMap(v['attack'], 0.001, 2.5), // 1 ms – 2.5 s (spec)
    decay: expMap(v['decay'], 0.002, 10), // 2 ms – 10 s (spec)
    sustain: v['sustain'],
    release: expMap(v['release'], 0.002, 10), // 2 ms – 10 s (spec)
    envTrigger: ENV_TRIGGERS[stepIndex(v['envTrigger'], 3)],
    portaTime: v['portaTime'] < 0.01 ? 0 : expMap(v['portaTime'], 0.005, 5) / 4, // 0–5 s (spec)
    bendVco: v['bendVco'] * 1200, // bender SENSITIVITY VCO: up to ±1 octave (our figure)
    bendVcf: v['bendVcf'] * 4800, // SENSITIVITY VCF: up to ±4 octaves (our figure)
    volume: v['volume'] * v['volume'],
  };
}

export type Sh2Settings = ReturnType<typeof sh2Settings>;

/**
 * Should a key event (re)start the envelope? The KCV & TRIG board (p.7) differentiates the key
 * voltage, so in GATE+TRIG every change of the sounding note retriggers; GATE only fires from
 * silence (legato lines keep one envelope); LFO leaves it to the modulator.
 */
export function envTriggers(mode: EnvTrigger, fromSilence: boolean, noteChanged: boolean) {
  if (mode === 'lfo') return false;
  return fromSilence || (mode === 'gateTrig' && noteChanged);
}

/**
 * LFO DELAY: after each trigger the modulation fades in over the delay time (the DELAY block
 * between the trigger and the LFO, p.2). Depth 0…1 at `t` seconds after the key.
 */
export function lfoDelayDepth(t: number, delay: number) {
  if (delay <= 0) return 1;
  return Math.max(0, Math.min(1, t / delay));
}

/**
 * VCO-1's ∿ wave: the triangle core rounded off by the diode clipper after IC19 (D17 / D18,
 * p.4), close to a sine. One cycle, peak ±1.
 */
export function roundedTriangle(n = 1024): Float32Array<ArrayBuffer> {
  const k = 1.6;
  return Float32Array.from({ length: n }, (_, i) => {
    const x = i / n;
    const tri = x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    return Math.tanh(k * tri) / Math.tanh(k);
  });
}

// ── Catalog entry ──────────────────────────────────────

/**
 * The jacks sit in the strip along the back, left end, as seen from the front (p.1 rear view:
 * OUTPUT, PHONES, CV / GATE OUT, GATE / CV IN, AUDIO IN). NOTE OUT stands in for CV / GATE OUT
 * and NOTE IN for CV / GATE IN.
 */
export const SH2_GEAR: GearDef = {
  kind: 'sh2',
  label: 'SH-2',
  category: 'synth',
  w: 20,
  h: 7,
  jacks: [
    { id: 'out', dir: 'out', fx: 0.02, fy: 0.04, label: 'OUTPUT' },
    ...noteJacks([0.1, 0.04], [0.06, 0.04]),
    { id: 'in', dir: 'in', fx: 0.14, fy: 0.04, label: 'AUDIO IN' },
  ],
  params: [
    // MODULATOR
    { ...p('lfoRate', 'RATE', 0.5), slider: true },
    { ...p('lfoDelay', 'DELAY', 0), slider: true },
    sel('lfoWave', 'MODE', ['SINE', 'SQUARE', 'RANDOM'], 0),
    // VCO
    { ...p('vcoMod', 'MOD', 0), slider: true },
    { ...p('autoBend', 'AUTO BEND', 0), slider: true },
    { ...p('pulseWidth', 'PW', 0.3), slider: true },
    sel('pwmSource', 'PWM', ['LFO', 'MAN', 'ENV'], 1),
    bi('tune', 'TOTAL TUNE'),
    // VCO-1
    sel('range1', 'RANGE', ["32'", "16'", "8'", "4'", "2'"], 1),
    sel('wave1', 'WAVEFORM', ['SINE', 'SAW', 'SQUARE', 'PULSE'], 1),
    rocker('bendVco1', 'BENDER', 'white', true),
    // VCO-2
    sel('range2', 'RANGE', ["32'", "16'", "8'", "4'", "2'"], 1),
    sel('wave2', 'WAVEFORM', ['NOISE', 'SAW', 'SQUARE', 'PULSE'], 2),
    bi('tune2', 'VCO-2 TUNE', 0.52),
    sel('tuneRange', 'TUNE', ['WIDE', 'NARROW'], 1),
    // SOURCE MIXER
    { ...p('sub', 'SUB', 0.4), slider: true },
    { ...p('vco1', 'VCO-1', 0.8), slider: true },
    { ...p('vco2', 'VCO-2', 0.6), slider: true },
    // VCF
    { ...p('cutoff', 'CUTOFF', 0.5), slider: true },
    { ...p('resonance', 'RES', 0.2), slider: true },
    sel('vcfEnvSource', 'ENV', ["ENV FOL'R", 'ENV +', 'ENV −'], 1),
    { ...p('vcfEnv', 'ENV', 0.45), slider: true },
    { ...p('vcfMod', 'MOD', 0), slider: true },
    { ...p('vcfKybd', 'KYBD', 0.5), slider: true },
    // VCA
    sel('vcaMode', 'VCA', ['HOLD', 'ENV', 'GATE'], 1),
    // ENV
    { ...p('attack', 'A', 0.05), slider: true },
    { ...p('decay', 'D', 0.45), slider: true },
    { ...p('sustain', 'S', 0.6), slider: true },
    { ...p('release', 'R', 0.4), slider: true },
    sel('envTrigger', 'GATE', ['GATE+TRIG', 'GATE', 'LFO'], 0),
    // Left of the keys
    p('volume', 'VOLUME', 0.7),
    { ...p('portaTime', 'PORTAMENTO', 0), slider: true },
    { ...p('bendVco', 'VCO', 0.2), slider: true },
    { ...p('bendVcf', 'VCF', 0), slider: true },
  ],
  // The panel is its own component (gear/sh2-panel), laid out like the hardware.
  keyboard: { from: -12, keys: 37 }, // 37 keys, 3 octaves (spec)
};
