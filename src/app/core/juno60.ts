// JUNO-60 maths (1982): six voices, each a DCO (saw, pulse, sub, noise) → 24 dB VCF → VCA with
// one ADSR, summed into a non-resonant HPF, the VCA LEVEL and the stereo BBD chorus. After the
// service notes (first edition, 10 Apr. 1983): specifications p.1, block diagram p.3, chorus LFO
// on panel board B p.7, chorus board p.11, circuit descriptions pp.14–16 (key assignment, master
// oscillator ranges, PWM, VCF control voltages), adjustment procedures pp.22–25. Interpretation
// notes in docs/devices/juno60.md.

import { type GearDef, noteJacks, p, rocker, sel } from './gear-types.ts';
import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** Six voice channels, CH1–CH6 (p.14 KEY ASSIGNMENT). */
export const VOICES = 6;

/** OCTAVE TRANSPOSE on the bender panel: DOWN / NORMAL / UP. */
const OCTAVES = [-12, 0, 12];

export type ArpMode = 'up' | 'updown' | 'down';
const ARP_MODES: ArpMode[] = ['up', 'updown', 'down'];
export type PwmMode = 'lfo' | 'man' | 'env';
const PWM_MODES: PwmMode[] = ['lfo', 'man', 'env'];
/** CHORUS: the I and II buttons as two bits (OFF, I, II, I+II). */
export type Chorus = 'off' | 'I' | 'II' | 'I+II';
export const CHORUS_MODES: Chorus[] = ['off', 'I', 'II', 'I+II'];

/**
 * ARP CLOCK EXT: the ARPEGGIO CLOCK jack takes one step per pulse (spec); here the "pulses" are
 * the song tempo, and RATE picks the note value.
 */
export const ARP_DIVISIONS = [1, 1 / 2, 1 / 3, 1 / 4, 1 / 6, 1 / 8];
export const ARP_DIVISION_LABELS = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];

/**
 * The HPF on the chorus board (p.11): a 4051 picks no capacitor (position 0, flat) or 0.022 /
 * 0.01 / 0.0047 µF in series with the VCA input, loaded by 470 kΩ to ground and the 33 kΩ into
 * the VCA's virtual-earth input. One pole each: f = 1 / (2π R C).
 */
const HPF_LOAD = 1 / (1 / 33e3 + 1 / 470e3);
export const HPF_FREQS = [0, 0.022e-6, 0.01e-6, 0.0047e-6].map((c) =>
  c ? 1 / (2 * Math.PI * HPF_LOAD * c) : 0,
);

/**
 * VCF FREQ: adjustment 8-2 / 8-3 (p.24) tunes the self-oscillating filter to 248 Hz with FREQ at
 * 3 and the key C4 (the KYBD pivot); the slider is linear in volts, so exponential in Hz. We give
 * it ten octaves, which puts 0 at 31 Hz and 10 above the audio band.
 */
export const VCF_LOW = 248 / Math.pow(2, 3);
export const VCF_OCTAVES = 10;
/** ENV at 10 opens the filter from FREQ 0 to ≈30 kHz (adjustment 8-9: T ≈ 34 µs). */
export const VCF_ENV_OCTAVES = Math.log2(30000 / VCF_LOW);
/** VCF LFO at 10 swings the cutoff between ≈45 Hz and ≈4.5 kHz (adjustment 8-7): ±3.3 octaves. */
export const VCF_LFO_OCTAVES = Math.log2(4500 / 45) / 2;

/**
 * The chorus: two MN3009 BBDs (p.11), one swept by the chorus LFO's triangle and the other by its
 * inverse (panel board B pins 40 / 39), each mixed with the direct signal into its own output.
 * The notes print neither the LFO rates nor the delay sweep; these are the hardware's commonly
 * published measurements.
 */
export const CHORUS: Record<Exclude<Chorus, 'off'>, { rate: number; min: number; max: number }> = {
  I: { rate: 0.513, min: 0.00166, max: 0.00535 },
  II: { rate: 0.863, min: 0.00166, max: 0.00535 },
  'I+II': { rate: 9.75, min: 0.0033, max: 0.0037 },
};
/** BBD wet against the direct signal at the output mixer IC8 (47 kΩ vs 39 kΩ). */
export const CHORUS_WET = 39 / 47;
/**
 * The anti-alias filters around the BBDs: two Sallen–Key low-passes, 22 kΩ / 22 kΩ with 820 pF /
 * 680 pF and 0.0018 µF / 270 pF, f = 1 / (2π R √(C1 C2)).
 */
export const CHORUS_LOWPASS = [
  [820e-12, 680e-12],
  [0.0018e-6, 270e-12],
].map(([c1, c2]) => 1 / (2 * Math.PI * 22e3 * Math.sqrt(c1 * c2)));

const time = (v: number, min: number, max: number) => expMap(v, min, max);

export function juno60Settings(p: Params) {
  const arpDivision = ARP_DIVISIONS[stepIndex(p['arpRate'], ARP_DIVISIONS.length)];
  return {
    arp: p['arp'] >= 0.5,
    arpMode: ARP_MODES[stepIndex(p['arpMode'], 3)],
    arpRange: stepIndex(p['arpRange'], 3) + 1,
    arpRate: expMap(p['arpRate'], 1.5, 50), // 1.5–50 Hz (spec)
    /** EXT: steps on the song tempo, one per `arpDivision` beats. */
    arpExt: p['arpClock'] >= 0.5,
    arpDivision,
    hold: p['hold'] >= 0.5,
    lfoRate: expMap(p['lfoRate'], 0.3, 20), // 0.3–20 Hz (spec)
    lfoDelay: p['lfoDelay'] * 1.5, // 0–1.5 s (spec)
    lfoManual: p['lfoTrig'] >= 0.5, // TRIG MODE AUTO / MAN
    /** DCO LFO: the master oscillator takes ±300 cent from the LFO (p.14). */
    dcoLfo: p['dcoLfo'] * 300,
    /** PWM: 50 % at 0, 95 % at 10 (adjustments 9-1, 9-2), as a duty cycle. */
    pulseWidth: 0.5 - p['pw'] * 0.45,
    pwmMode: PWM_MODES[stepIndex(p['pwmMode'], 3)],
    pulse: p['pulse'] >= 0.5,
    saw: p['saw'] >= 0.5,
    subOn: p['subOn'] >= 0.5,
    sub: p['sub'],
    noise: p['noise'],
    hpf: HPF_FREQS[stepIndex(p['hpf'], 4)],
    cutoff: VCF_LOW * Math.pow(2, p['cutoff'] * VCF_OCTAVES),
    /** RES up to self-oscillation (spec); Web Audio Q is in dB. */
    resonance: p['res'] * p['res'] * 26,
    /** ENV with its polarity switch, in cents of cutoff. */
    vcfEnv: (p['envPolarity'] >= 0.5 ? -1 : 1) * p['vcfEnv'] * VCF_ENV_OCTAVES * 1200,
    vcfLfo: p['vcfLfo'] * VCF_LFO_OCTAVES * 1200,
    vcfKybd: p['vcfKybd'], // 0–100 % (spec)
    vcaGate: p['vcaMode'] >= 0.5, // VCA: ENV or GATE
    /** VCA LEVEL (the chorus board's IC6), unity at 5. */
    vcaLevel: p['vcaLevel'] * 2,
    attack: time(p['attack'], 0.001, 3), // 1 ms – 3 s (spec)
    decay: time(p['decay'], 0.002, 12), // 2 ms – 12 s
    sustain: p['sustain'],
    release: time(p['release'], 0.002, 12), // 2 ms – 12 s
    chorus: CHORUS_MODES[stepIndex(p['chorus'], 4)],
    volume: p['volume'] * p['volume'],
    tuneCents: (p['tune'] * 2 - 1) * 50, // ±50 cent (spec, p.14)
    /** Bender depth knobs: DCO up to ±700 cent (p.14), VCF up to ±2 octaves (our choice). */
    bendDco: p['bendDco'] * 700,
    bendVcf: p['bendVcf'] * 2400,
    octave: OCTAVES[stepIndex(p['octave'], 3)],
  };
}

export type Juno60Settings = ReturnType<typeof juno60Settings>;

/** Seconds per arpeggio step: the RATE slider, or the tempo divided by RATE in EXT. */
export const arpStep = (s: Juno60Settings, bpm: number) =>
  s.arpExt ? (60 / bpm) * s.arpDivision : 1 / s.arpRate;

/**
 * PWM by comparator, as on the SH-101: a rising saw (−1…+1) plus a bias is high for (1 + bias) / 2
 * of the cycle. The Juno's sawtooth feeds the S/H & comparator the same way (p.14, fig. 2).
 */
export const pwmBias = (duty: number) => 2 * duty - 1;

/**
 * The cutoff's key follow in cents, around C4: adjustment 8-3 sets KYBD 0 and 10 to give the
 * same cutoff with C4 held, and 8-4 sets 10 to track two octaves from C4 to C6 exactly.
 */
export const kybdCents = (note: number, amount: number) => (note - 60) * 100 * amount;

/** A voice channel as the key assigner sees it. */
export interface Channel {
  key: number | null;
  /** Gate still on (key held, or an arpeggio note not yet ended). */
  down: boolean;
  /** When its gate went on (any increasing count). */
  since: number;
}

/**
 * Key assignment (p.14): channels are given out in the cyclic order CH1–CH6, starting after the
 * last one used; a 7th key while all six are held steals the channel of the first (oldest) key.
 * A key already sounding on a held channel (from two sources at once) strikes it again there.
 */
export function assignVoice(channels: readonly Channel[], last: number, key: number): number {
  const n = channels.length;
  const same = channels.findIndex((c) => c.down && c.key === key);
  if (same >= 0) return same;
  for (let i = 1; i <= n; i++) {
    const c = (last + i) % n;
    if (!channels[c].down) return c;
  }
  let oldest = 0;
  for (let i = 1; i < n; i++) if (channels[i].since < channels[oldest].since) oldest = i;
  return oldest;
}

/**
 * Arpeggio order over the held keys and RANGE octaves: UP lowest → highest, DOWN highest →
 * lowest, UP & DOWN up then down without repeating the turning notes.
 */
export function arpeggio(held: readonly number[], mode: ArpMode, range: number): number[] {
  const keys = [...new Set(held)].sort((a, b) => a - b);
  const up = Array.from({ length: range }, (_, o) => keys.map((k) => k + 12 * o)).flat();
  if (mode === 'down') return up.reverse();
  if (mode === 'updown') return up.length > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
  return up;
}

/** First-order high-pass (bilinear transform) as IIRFilterNode coefficients. */
export function onePoleHighpass(fc: number, sampleRate: number) {
  const k = Math.tan((Math.PI * fc) / sampleRate);
  const b = 1 / (1 + k);
  return { feedforward: [b, -b], feedback: [1, (k - 1) / (k + 1)] };
}

/** Magnitude of a first-order IIR filter at frequency f (for the tests). */
export function iirGain(c: { feedforward: number[]; feedback: number[] }, f: number, rate: number) {
  const w = (2 * Math.PI * f) / rate;
  const z = (k: number[]) => {
    const re = k[0] + k[1] * Math.cos(-w);
    const im = k[1] * Math.sin(-w);
    return Math.hypot(re, im);
  };
  return z(c.feedforward) / z(c.feedback);
}

/** KEY TRANSPOSE: the amount kept in the patch, clamped to ±2 octaves. */
export function parseTranspose(text: string | undefined): number {
  const n = Math.round(Number(text ?? 0));
  return Number.isFinite(n) ? Math.max(-24, Math.min(24, n)) : 0;
}

/**
 * PATCH 1–8 of the memory section, used here as presets. The hardware's factory sounds aren't
 * reproduced; these are starting points in its spirit.
 */
export const PATCHES: { name: string; params: Params }[] = [
  {
    name: 'STRINGS',
    params: {
      saw: 1,
      pulse: 0,
      subOn: 0,
      sub: 0,
      noise: 0,
      pw: 0,
      dcoLfo: 0.04,
      hpf: 1 / 3,
      cutoff: 0.62,
      res: 0,
      vcfEnv: 0.1,
      vcfLfo: 0,
      vcfKybd: 0.4,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0.55,
      decay: 0.6,
      sustain: 0.85,
      release: 0.55,
      chorus: 2 / 3,
      lfoRate: 0.45,
      lfoDelay: 0.5,
      arp: 0,
    },
  },
  {
    name: 'BRASS',
    params: {
      saw: 1,
      pulse: 0,
      subOn: 1,
      sub: 0.35,
      noise: 0,
      pw: 0,
      dcoLfo: 0,
      hpf: 1 / 3,
      cutoff: 0.32,
      res: 0.15,
      vcfEnv: 0.45,
      vcfLfo: 0,
      vcfKybd: 0.6,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0.3,
      decay: 0.45,
      sustain: 0.6,
      release: 0.3,
      chorus: 1 / 3,
      arp: 0,
    },
  },
  {
    name: 'PWM PAD',
    params: {
      saw: 0,
      pulse: 1,
      subOn: 0,
      sub: 0,
      noise: 0,
      pw: 0.6,
      pwmMode: 0,
      lfoRate: 0.35,
      lfoDelay: 0,
      dcoLfo: 0,
      hpf: 0,
      cutoff: 0.55,
      res: 0.1,
      vcfEnv: 0.15,
      vcfLfo: 0,
      vcfKybd: 0.3,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0.5,
      decay: 0.6,
      sustain: 0.8,
      release: 0.6,
      chorus: 1 / 3,
      arp: 0,
    },
  },
  {
    name: 'BASS',
    params: {
      saw: 1,
      pulse: 1,
      pw: 0.35,
      pwmMode: 0.5,
      subOn: 1,
      sub: 0.8,
      noise: 0,
      dcoLfo: 0,
      hpf: 0,
      cutoff: 0.22,
      res: 0.35,
      vcfEnv: 0.4,
      vcfLfo: 0,
      vcfKybd: 0.5,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0,
      decay: 0.38,
      sustain: 0.25,
      release: 0.15,
      chorus: 0,
      arp: 0,
    },
  },
  {
    name: 'LEAD',
    params: {
      saw: 1,
      pulse: 0,
      subOn: 1,
      sub: 0.5,
      noise: 0,
      dcoLfo: 0.12,
      lfoRate: 0.55,
      lfoDelay: 0.6,
      lfoTrig: 0,
      hpf: 1 / 3,
      cutoff: 0.48,
      res: 0.45,
      vcfEnv: 0.3,
      vcfLfo: 0,
      vcfKybd: 0.7,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0.05,
      decay: 0.5,
      sustain: 0.7,
      release: 0.3,
      chorus: 1 / 3,
      arp: 0,
    },
  },
  {
    name: 'ORGAN',
    params: {
      saw: 0,
      pulse: 1,
      pw: 0,
      pwmMode: 0.5,
      subOn: 1,
      sub: 0.7,
      noise: 0,
      dcoLfo: 0,
      hpf: 1 / 3,
      cutoff: 0.7,
      res: 0,
      vcfEnv: 0,
      vcfLfo: 0,
      vcfKybd: 0.5,
      envPolarity: 0,
      vcaMode: 1,
      attack: 0,
      decay: 0.3,
      sustain: 1,
      release: 0.1,
      chorus: 1,
      arp: 0,
    },
  },
  {
    name: 'CLAV',
    params: {
      saw: 0,
      pulse: 1,
      pw: 0.7,
      pwmMode: 0.5,
      subOn: 0,
      sub: 0,
      noise: 0,
      dcoLfo: 0,
      hpf: 2 / 3,
      cutoff: 0.4,
      res: 0.4,
      vcfEnv: 0.45,
      vcfLfo: 0,
      vcfKybd: 0.8,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0,
      decay: 0.3,
      sustain: 0,
      release: 0.2,
      chorus: 0,
      arp: 0,
    },
  },
  {
    name: 'ARPEGGIO',
    params: {
      saw: 1,
      pulse: 1,
      pw: 0.4,
      pwmMode: 0,
      lfoRate: 0.3,
      subOn: 1,
      sub: 0.4,
      noise: 0,
      dcoLfo: 0,
      hpf: 1 / 3,
      cutoff: 0.35,
      res: 0.5,
      vcfEnv: 0.4,
      vcfLfo: 0.1,
      vcfKybd: 0.6,
      envPolarity: 0,
      vcaMode: 0,
      attack: 0,
      decay: 0.35,
      sustain: 0.2,
      release: 0.3,
      chorus: 1 / 3,
      arp: 1,
      arpMode: 0.5,
      arpRange: 0.5,
    },
  },
];

// JUNO-60 (1982): 6 voices, DCO → HPF / VCF / VCA, one ENV, LFO with delay, arpeggiator and the
// stereo chorus. The stereo OUT and the NOTE jacks sit in the rear-panel strip along the top.
export const JUNO60_GEAR: GearDef = {
  kind: 'juno60',
  label: 'JUNO-60',
  category: 'synth',
  w: 24,
  h: 9,
  jacks: [
    ...noteJacks([0.79, 0.025], [0.835, 0.025]),
    { id: 'out', dir: 'out', fx: 0.975, fy: 0.025, label: 'OUTPUT' },
  ],
  params: [
    // Arpeggio, hold, key transpose
    rocker('arp', 'ARPEGGIO', 'white', false),
    sel('arpMode', 'MODE', ['UP', 'U&D', 'DOWN'], 0),
    sel('arpRange', 'RANGE', ['1', '2', '3'], 0),
    { ...p('arpRate', 'RATE', 0.5), slider: true },
    sel('arpClock', 'ARP CLOCK', ['INT', 'EXT'], 0),
    rocker('hold', 'HOLD', 'white', false),
    // LFO
    { ...p('lfoRate', 'RATE', 0.5), slider: true },
    { ...p('lfoDelay', 'DELAY', 0), slider: true },
    sel('lfoTrig', 'TRIG MODE', ['AUTO', 'MAN'], 0),
    // DCO
    { ...p('dcoLfo', 'LFO', 0), slider: true },
    { ...p('pw', 'PWM', 0), slider: true },
    sel('pwmMode', 'PWM MODE', ['LFO', 'MAN', 'ENV'], 1),
    rocker('pulse', 'PULSE', 'orange', false),
    rocker('saw', 'SAW', 'orange', true),
    rocker('subOn', 'SUB', 'orange', false),
    { ...p('sub', 'SUB', 0.5), slider: true },
    { ...p('noise', 'NOISE', 0), slider: true },
    // HPF, VCF, VCA, ENV
    { ...sel('hpf', 'HPF', ['0', '1', '2', '3'], 1), slider: true },
    { ...p('cutoff', 'FREQ', 0.55), slider: true },
    { ...p('res', 'RES', 0.1), slider: true },
    sel('envPolarity', 'ENV POLARITY', ['+', '−'], 0),
    { ...p('vcfEnv', 'ENV', 0.3), slider: true },
    { ...p('vcfLfo', 'LFO', 0), slider: true },
    { ...p('vcfKybd', 'KYBD', 0.5), slider: true },
    sel('vcaMode', 'VCA', ['ENV', 'GATE'], 0),
    { ...p('vcaLevel', 'LEVEL', 0.5), slider: true },
    { ...p('attack', 'A', 0.1), slider: true },
    { ...p('decay', 'D', 0.5), slider: true },
    { ...p('sustain', 'S', 0.6), slider: true },
    { ...p('release', 'R', 0.35), slider: true },
    sel('chorus', 'CHORUS', ['OFF', 'I', 'II', 'I+II'], 1),
    // Bender panel and rear
    p('volume', 'VOLUME', 0.7),
    p('bendDco', 'DCO', 0.3),
    p('bendVcf', 'VCF', 0),
    sel('octave', 'OCTAVE TRANSPOSE', ['DOWN', 'NORMAL', 'UP'], 1),
    { ...p('tune', 'TUNE', 0.5), bipolar: true },
  ],
  // The panel is its own component (gear/juno60-panel), laid out like the hardware.
  keyboard: { from: -12, keys: 61 }, // 61 keys, 5 octaves (spec)
};
