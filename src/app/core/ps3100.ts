// PS-3100 maths (1977): a fully polyphonic synthesizer with a filter, amplifier and envelope for
// every one of its 48 keys, fed by a divide-down oscillator bank, then three resonators, an
// amplitude modulator, an ensemble and two VCAs shared by all keys. Sources: the front panel
// (photo), the resonator board schematic (K. Ishii, Feb. 1977) and the board connector list
// (KLM-64 signal, KLM-69 gate / voice, KLM-62 / 63 / 76 control boards). Interpretation notes in
// docs/devices/ps3100.md.

import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** 48 keys, C to B over four octaves (one voice board channel per key). */
export const PS_KEYS = 48;
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * WAVE FORM: the connector list names the selects on KLM-63 (Saw, Tri, P50 %, P30 %, P10 %, PWM).
 */
export type Wave = 'saw' | 'tri' | 'pulse50' | 'pulse30' | 'pulse10' | 'pwm';
export const WAVES: Wave[] = ['saw', 'tri', 'pulse50', 'pulse30', 'pulse10', 'pwm'];
export const WAVE_LABELS = ['SAW', 'TRI', 'PULSE 50%', 'PULSE 30%', 'PULSE 10%', 'PWM'];
/** Duty cycle of the fixed pulse positions. */
export const DUTY: Partial<Record<Wave, number>> = { pulse50: 0.5, pulse30: 0.3, pulse10: 0.1 };

/** SCALE: the 16' / 8' / 4' divider outputs (KLM-64 pins 36–38). */
export const SCALE_RATIO = [0.5, 1, 2];
export const SCALE_LABELS = ["16'", "8'", "4'"];

/** Modulation generator 1 outputs (KLM-63): saw down, saw up, triangle, rectangle, pink, white. */
export type Mg1Wave = 'sawDown' | 'sawUp' | 'triangle' | 'square' | 'pink' | 'white';
export const MG1_WAVES: Mg1Wave[] = ['sawDown', 'sawUp', 'triangle', 'square', 'pink', 'white'];
export const MG1_LABELS = ['SAW ↘', 'SAW ↗', 'TRI', 'RECT', 'PINK', 'WHITE'];

/** General envelope generator KBD TRIGGER SELECT. */
export type KbdTrigger = 'off' | 'single' | 'multi';
export const KBD_TRIGGERS: KbdTrigger[] = ['off', 'single', 'multi'];

/**
 * Resonator board: three multiple-feedback band-passes tuned by photocouplers. Each pairs a
 * 0.082 µF input capacitor with an 820 pF feedback one (the "yellow" row of the table, and every
 * other colour keeps the same 100 : 1 ratio), so with matched photocells Q = √(C1/C2) / 2 = 5.
 */
export const RESONATOR_Q = Math.sqrt(0.082e-6 / 820e-12) / 2;

/**
 * The resonator board's input high-pass: two 0.033 µF capacitors with 100 kΩ and 68 kΩ,
 * f = 1 / (2π C √(R1 R2)) ≈ 58 Hz.
 */
export const RES_HIGHPASS = 1 / (2 * Math.PI * 0.033e-6 * Math.sqrt(100e3 * 68e3));

const time = (v: number, min: number, max: number) => expMap(v, min, max);
/** A centre-detented knob → -1…+1. */
const bipolar = (v: number) => v * 2 - 1;

export function ps3100Settings(p: Params) {
  return {
    /** TEMPERAMENT ADJUST: one trimmer per note of the top octave, ±50 cent. */
    temperament: NOTE_NAMES.map((_, i) => bipolar(p[`temper${i}`] ?? 0.5) * 50),
    wave: WAVES[stepIndex(p['wave'], WAVES.length)],
    /** PULSE WIDTH MODULATION INTENSITY: how far MG1 swings the PWM pulse from 50 %. */
    pwmDepth: p['pwmDepth'] * 0.45,
    coarse: bipolar(p['coarse']) * 700, // ±a fifth, in cents
    fine: bipolar(p['fine']) * 50,
    ratio: SCALE_RATIO[stepIndex(p['scale'], 3)],
    /** FREQUENCY MODULATION intensities (MG1, S/H), up to an octave, in cents. */
    fmMg1: p['fmMg1'] * p['fmMg1'] * 1200,
    fmSh: p['fmSh'] * p['fmSh'] * 1200,
    cutoff: expMap(p['cutoff'], 30, 18000),
    /** PEAK: the per-key filter's resonance (Web Audio Q is in dB). */
    peak: p['peak'] * p['peak'] * 22,
    /** KBD FILTER BALANCE: tilts the cutoff between the low and high ends of the keyboard. */
    kbdBalance: bipolar(p['kbdBalance']),
    /** EXPAND: how far each key's envelope opens its filter, in cents. */
    expand: p['expand'] * 6000,
    cutMg1: p['cutMg1'] * p['cutMg1'] * 3600,
    cutSh: p['cutSh'] * p['cutSh'] * 3600,
    attack: time(p['attack'], 0.002, 10),
    decay: time(p['decay'], 0.004, 10),
    sustain: p['sustain'],
    /** RELEASE: DAMPED stops a key quickly; ON lets it die away at the decay time. */
    releaseOn: p['release'] >= 0.5,
    kbdHold: p['kbdHold'] >= 0.5,
    /** RESONANCE INTENSITY: crossfade from the dry signal (RES OUT 2) to the peaks (RES OUT 1). */
    resIntensity: p['resIntensity'],
    peaks: [p['res1'], p['res2'], p['res3']].map((v) => expMap(v, 60, 6000)),
    resMg2: p['resMg2'] >= 0.5,
    /** EXTERNAL PEAK FREQUENCY MODULATION: here the general envelope, in cents. */
    resExt: p['resExt'] * 3600,
    shRate: expMap(p['shRate'], 0.2, 40),
    shSync: p['shSync'] >= 0.5,
    mg1Rate: expMap(p['mg1Rate'], 0.05, 40),
    mg1Wave: MG1_WAVES[stepIndex(p['mg1Wave'], MG1_WAVES.length)],
    mg2Rate: expMap(p['mg2Rate'], 0.05, 40),
    /** AMPLITUDE MODULATOR: MG2 tremolo depth. */
    am: p['am'],
    ensemble: p['ensemble'] >= 0.5,
    gegDelay: p['gegDelay'] < 0.01 ? 0 : time(p['gegDelay'], 0.005, 5),
    gegAttack: time(p['gegAttack'], 0.002, 10),
    gegRelease: time(p['gegRelease'], 0.004, 10),
    kbdTrigger: KBD_TRIGGERS[stepIndex(p['kbdTrigger'], 3)],
    gegAuto: p['gegAuto'] >= 0.5,
    /** The orange switch into VCA 2: the general envelope shapes the whole keyboard's level. */
    gegVca: p['gegVca'] >= 0.5,
    /** VOLTAGE PROCESSORS, pre-patched: VP1 general envelope → cutoff, VP2 → pitch (cents). */
    vp1: (p['vp1a'] - p['vp1b']) * 4800,
    vp2: (p['vp2a'] - p['vp2b']) * 1200,
    kbdVolBalance: bipolar(p['kbdVolBalance']),
    volume: p['volume'] * p['volume'],
    phones: p['phones'] * p['phones'],
    direct: p['direct'] * p['direct'],
  };
}

export type Ps3100Settings = ReturnType<typeof ps3100Settings>;

/** A key's pitch: equal temperament, then its note's TEMPERAMENT ADJUST trimmer. */
export function keyFreq(note: number, s: Ps3100Settings): number {
  const cents = s.temperament[((note % 12) + 12) % 12] + s.coarse + s.fine;
  return 440 * Math.pow(2, (note - 69) / 12 + cents / 1200) * s.ratio;
}

/**
 * Where a key's filter sits, in cents from the CUTOFF knob: it follows the key (as the per-key
 * filters do, each on its own key's CV), and KBD FILTER BALANCE adds up to ±2 octaves across the
 * keyboard (the FC U / FC L voltages for its upper and lower ends).
 */
export const filterKeyCents = (note: number, balance: number) =>
  (note - 60) * 100 + balance * ((note - 60) / 24) * 2400;

/** KEYBOARD VOLUME BALANCE: louder at one end, quieter at the other (0…2, 1 in the middle). */
export const keyLevel = (note: number, balance: number) =>
  Math.max(0, Math.min(2, 1 + balance * ((note - 60) / 24)));

/** One cycle of the selected wave for a fixed pulse width, or null for the native oscillator types. */
export const fixedDuty = (wave: Wave): number | null => DUTY[wave] ?? null;
