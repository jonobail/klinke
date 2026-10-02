// The DPS multi-effect types, shared by the DPS-V55 and DPS-V77 effect blocks.
//
// Source: DPS-V55 Effect Parameter Guide, "List of Effects" (p.2) and one page per effect
// (pp.5–48), which give each effect's parameters in order with their ranges. On the hardware the
// EDIT PARAMETER buttons step through them and the rotary encoder sets the value; here each
// block has three knobs (P1–P3) for the three parameters that shape the sound most, and the rest
// sit at the values in `fixed` (our choice, recorded in docs/devices/dps-v55.md).
//
// Every knob's range is the guide's own; `fxValues` turns the three knob positions into the
// engine's units (seconds, Hz, cents, -1…+1 feedback, 0–1 amounts) for the audio side.

import { choice, clamp, expKnob, lerp } from './dps-dsp.ts';

/** How a knob's 0–1 maps onto its printed range. */
export type Unit =
  | 's' // seconds, exponential
  | 'ms' // milliseconds, square law
  | 'pct' // 0 ~ 100
  | 'fb' // –99 ~ +99
  | 'c' // cents
  | 'dB'
  | 'Hz' // exponential
  | 'x' // plain number
  | 'opt'; // one of `options`

export interface Knob {
  /** Short name for the display (≤ 5 characters, as the V55 display abbreviates). */
  name: string;
  /** Which engine input it drives. */
  key: string;
  unit: Unit;
  min: number;
  max: number;
  options?: string[];
}

/** What the audio side builds for an effect. Pairs are the guide's Mono-Pair (M-P) effects. */
export type Engine =
  | 'reverb'
  | 'er'
  | 'dim'
  | 'chorus'
  | 'rotary'
  | 'delay'
  | 'pitch'
  | 'flanger'
  | 'phaser'
  | 'panner'
  | 'haas'
  | 'drive'
  | 'eq'
  | 'amp'
  | 'dynamics'
  | 'exciter'
  | 'gate'
  | 'tremolo'
  | 'vibrato'
  | 'wah'
  | 'ringmod'
  | 'moddelay'
  | 'taps'
  | 'pair';

export interface FxDef {
  /** Effect number on the V55 front-panel list (0 for the V77-only types). */
  no: number;
  /** Display abbreviation, as printed in the guide (e.g. StDLY). */
  code: string;
  name: string;
  /** 4ch effects take the whole processor: FxB is switched off (V55 manual p.8). */
  ch: '4ch' | '2ch' | 'M-P';
  engine: Engine;
  /** Mono-Pair: the left and right channel engines. */
  pair?: [Engine, Engine];
  /** P1–P3 (fewer where the guide has fewer parameters). */
  knobs: Knob[];
  /** Engine inputs not on a knob, in engine units. */
  fixed?: Record<string, number>;
  /** Dynamics / EQ / drive: no Direct / Effect levels in the guide, so the block is all effect. */
  insert?: boolean;
  /** Effect Parameter Guide page. */
  page: number;
}

const k = (
  name: string,
  key: string,
  unit: Unit,
  min: number,
  max: number,
  options?: string[],
): Knob => ({
  name,
  key,
  unit,
  min,
  max,
  options,
});

// The knobs that recur.
const RATE = k('Rate', 'rate', 'pct', 0, 100);
const DEPTH = k('Depth', 'depth', 'pct', 0, 100);
const HIDAMP = k('HiDmp', 'hiDamp', 'pct', 0, 100);
const FORM = k('Form', 'wave', 'opt', 0, 1, ['Sin', 'Tri']);
const CHPHASE = k('ChPhs', 'chPhase', 'x', 0, 20);
const revTime = (min = 0.3, max = 50) => k('RevT', 'rt', 's', min, max);
const preDelay = (max: number) => k('PreDl', 'pre', 'ms', 0, max);
const dlyTime = (name: string, key: string, max = 1360) => k(name, key, 'ms', 0, max);
const FB = k('FB', 'fb', 'fb', -99, 99);
const PITCH = k('Pitch', 'pitch', 'c', -2400, 2400);
const GAIN = (name: string, key: string) => k(name, key, 'dB', -24, 12);

const reverb = (
  no: number,
  code: string,
  name: string,
  ch: FxDef['ch'],
  pre: number,
  page: number,
  early: number,
  rt = revTime(),
): FxDef => ({
  no,
  code,
  name,
  ch,
  engine: 'reverb',
  knobs: [rt, preDelay(pre), HIDAMP],
  fixed: { size: code.startsWith('Room') ? 0.7 : code.startsWith('Hall') ? 1.2 : 1, early },
  page,
});

/** V55 effects 01–45 that this model builds (the rest are listed in docs/devices/dps-v55.md). */
export const V55_FX: FxDef[] = [
  reverb(1, 'Plat1', 'Plate Reverb 1', '4ch', 300, 5, 0),
  reverb(2, 'Hall1', 'Hall Reverb 1', '4ch', 400, 6, 0.5),
  reverb(3, 'Room1', 'Room Reverb 1', '4ch', 400, 7, 0.8),
  {
    no: 4,
    code: '3Dim1',
    name: '3 Dimension 1',
    ch: '4ch',
    engine: 'dim',
    knobs: [
      k('Pan1', 'pan1', 'x', -180, 180),
      k('Pan2', 'pan2', 'x', -180, 180),
      k('Pan3', 'pan3', 'x', -180, 180),
    ],
    page: 8,
  },
  {
    no: 5,
    code: 'DcCHO',
    name: 'Deca Chorus',
    ch: '4ch',
    engine: 'chorus',
    knobs: [RATE, DEPTH, preDelay(1200)],
    fixed: { voices: 5 },
    page: 9,
  },
  {
    no: 6,
    code: 'ENS',
    name: 'Ensemble',
    ch: '4ch',
    engine: 'chorus',
    knobs: [RATE, DEPTH, preDelay(1200)],
    fixed: { voices: 3, ensemble: 1 },
    page: 10,
  },
  {
    no: 7,
    code: 'Rotry',
    name: 'Rotary Speaker',
    ch: '4ch',
    engine: 'rotary',
    knobs: [
      k('Speed', 'fast', 'opt', 0, 1, ['Slow', 'Fast']),
      DEPTH,
      k('Drive', 'drive', 'pct', 0, 100),
    ],
    page: 11,
  },
  reverb(10, 'Plat2', 'Plate Reverb 2', '2ch', 150, 14, 0),
  reverb(11, 'Hall2', 'Hall Reverb 2', '2ch', 150, 15, 0.5),
  reverb(12, 'Room2', 'Room Reverb 2', '2ch', 150, 16, 0.8, revTime(0.12, 20)),
  {
    no: 13,
    code: '3Dim2',
    name: '3 Dimension 2',
    ch: '2ch',
    engine: 'dim',
    knobs: [k('Pan1', 'pan1', 'x', -180, 180), k('Pan2', 'pan2', 'x', -180, 180)],
    page: 17,
  },
  {
    no: 14,
    code: 'E/R',
    name: 'Early Reflection',
    ch: '2ch',
    engine: 'er',
    knobs: [
      k('Type', 'erType', 'opt', 0, 3, ['1', '2', '3', '4']),
      k('Level', 'erMode', 'opt', 0, 2, ['Dec', 'Fix', 'Inc']),
      preDelay(150),
    ],
    page: 18,
  },
  {
    no: 15,
    code: 'StDLY',
    name: 'Stereo Delay',
    ch: '2ch',
    engine: 'delay',
    knobs: [dlyTime('DlyL', 'time'), dlyTime('DlyR', 'timeR'), FB],
    fixed: { lpf: 8000 },
    page: 19,
  },
  {
    no: 16,
    code: 'PpDLY',
    name: 'Ping Pong Delay',
    ch: '2ch',
    engine: 'delay',
    knobs: [dlyTime('DlyL', 'time'), dlyTime('DlyR', 'timeR'), FB],
    fixed: { lpf: 6000, cross: 1 },
    page: 20,
  },
  {
    no: 17,
    code: 'StPCH',
    name: 'Stereo Pitch Shift',
    ch: '2ch',
    engine: 'pitch',
    knobs: [PITCH, k('PDly', 'pre', 'ms', 0, 500), k('PFB', 'fb', 'fb', -99, 99)],
    page: 21,
  },
  {
    no: 18,
    code: 'RvSFT',
    name: 'Reverse Shifter',
    ch: '2ch',
    engine: 'pitch',
    knobs: [k('Pitch', 'pitch', 'c', -1200, 1200), k('Len', 'window', 'ms', 20, 650), FB],
    fixed: { reverse: 1 },
    page: 22,
  },
  {
    no: 19,
    code: 'StCHO',
    name: 'Stereo Chorus',
    ch: '2ch',
    engine: 'chorus',
    knobs: [RATE, DEPTH, preDelay(500)],
    fixed: { voices: 2 },
    page: 23,
  },
  {
    no: 20,
    code: 'StFLN',
    name: 'Stereo Flanger',
    ch: '2ch',
    engine: 'flanger',
    knobs: [RATE, DEPTH, FB],
    page: 24,
  },
  {
    no: 21,
    code: 'StPHS',
    name: 'Stereo Phaser',
    ch: '2ch',
    engine: 'phaser',
    knobs: [RATE, DEPTH, k('Manu', 'manual', 'pct', 0, 100)],
    fixed: { resonance: 0.5 },
    page: 25,
  },
  {
    no: 22,
    code: 'StPAN',
    name: 'Stereo Panner',
    ch: '2ch',
    engine: 'panner',
    knobs: [RATE, DEPTH, FORM],
    page: 26,
  },
  {
    no: 23,
    code: 'HsPAN',
    name: 'Haas Panner',
    ch: '2ch',
    engine: 'haas',
    knobs: [RATE, DEPTH, FORM],
    page: 27,
  },
  {
    no: 24,
    code: 'Drivr',
    name: 'Driver',
    ch: '2ch',
    engine: 'drive',
    knobs: [
      k('Gain', 'gain', 'pct', 0, 100),
      k('Level', 'level', 'pct', 0, 100),
      k('Color', 'color', 'opt', 0, 5, ['1', '2', '3', '4', '5', '6']),
    ],
    insert: true,
    page: 28,
  },
  {
    no: 25,
    code: 'EQ',
    name: '3 Band EQ',
    ch: '2ch',
    engine: 'eq',
    knobs: [GAIN('LowG', 'low'), GAIN('MidG', 'mid'), GAIN('HighG', 'high')],
    insert: true,
    page: 29,
  },
  {
    no: 26,
    code: 'Amp',
    name: 'Amp Simulator',
    ch: '2ch',
    engine: 'amp',
    knobs: [
      k('Amp', 'amp', 'opt', 0, 3, ['Amp-F', 'Amp-B', 'Amp-M', 'Amp-J']),
      k('Mic', 'mic', 'opt', 0, 3, ['Front', 'Slant', 'Upper', 'On']),
      k('Level', 'level', 'pct', 0, 100),
    ],
    insert: true,
    page: 30,
  },
  {
    no: 27,
    code: 'Limit',
    name: 'Limiter',
    ch: '2ch',
    engine: 'dynamics',
    knobs: [
      k('Thres', 'threshold', 'pct', 0, 100),
      k('Ratio', 'ratio', 'x', 1, 20),
      k('Rel', 'release', 'pct', 0, 100),
    ],
    fixed: { limit: 1 },
    insert: true,
    page: 31,
  },
  {
    no: 28,
    code: 'Comp',
    name: 'Compressor',
    ch: '2ch',
    engine: 'dynamics',
    knobs: [
      k('Sens', 'sens', 'pct', 0, 100),
      k('Atk', 'attack', 'pct', 0, 100),
      k('Rel', 'release', 'pct', 0, 100),
    ],
    insert: true,
    page: 32,
  },
  {
    no: 29,
    code: 'Excit',
    name: 'Exciter',
    ch: '2ch',
    engine: 'exciter',
    knobs: [
      k('Gain', 'gain', 'pct', 0, 100),
      k('Freq', 'freq', 'x', 1, 32),
      k('Level', 'level', 'pct', 0, 100),
    ],
    insert: true,
    page: 33,
  },
  {
    no: 30,
    code: 'Gate',
    name: 'Gate',
    ch: '2ch',
    engine: 'gate',
    knobs: [
      k('Thres', 'threshold', 'pct', 0, 100),
      k('GTime', 'hold', 'ms', 0, 1000),
      k('Rel', 'release', 'pct', 0, 100),
    ],
    insert: true,
    page: 34,
  },
  {
    no: 31,
    code: 'Treml',
    name: 'Tremolo',
    ch: '2ch',
    engine: 'tremolo',
    knobs: [RATE, DEPTH, CHPHASE],
    insert: true,
    page: 35,
  },
  {
    no: 32,
    code: 'Vibrt',
    name: 'Vibrato',
    ch: '2ch',
    engine: 'vibrato',
    knobs: [RATE, DEPTH, CHPHASE],
    insert: true,
    page: 35,
  },
  {
    no: 33,
    code: 'Wah',
    name: 'Auto Wah',
    ch: '2ch',
    engine: 'wah',
    knobs: [
      k('Sens', 'sens', 'x', -100, 100),
      k('Atk', 'attack', 'x', 0, 50),
      k('Rel', 'release', 'x', 0, 50),
    ],
    insert: true,
    page: 36,
  },
  {
    no: 37,
    code: 'RV/DL',
    name: 'Reverb + Delay',
    ch: 'M-P',
    engine: 'pair',
    pair: ['reverb', 'delay'],
    knobs: [revTime(), dlyTime('Dly', 'time', 500), k('DlyFB', 'fb', 'fb', -99, 99)],
    fixed: { pre: 0.02, hiDamp: 0.6, size: 1, early: 0.3, lpf: 6000 },
    page: 40,
  },
  {
    no: 38,
    code: 'RV/CH',
    name: 'Reverb + Chorus',
    ch: 'M-P',
    engine: 'pair',
    pair: ['reverb', 'chorus'],
    knobs: [revTime(), RATE, DEPTH],
    fixed: { pre: 0.02, hiDamp: 0.6, size: 1, early: 0.3, voices: 2 },
    page: 41,
  },
  {
    no: 39,
    code: 'CH/DL',
    name: 'Chorus + Delay',
    ch: 'M-P',
    engine: 'pair',
    pair: ['chorus', 'delay'],
    knobs: [RATE, DEPTH, dlyTime('Dly', 'time', 500)],
    fixed: { voices: 2, fb: 0.3, lpf: 6000 },
    page: 42,
  },
  {
    no: 40,
    code: 'CH/CH',
    name: 'Chorus + Chorus',
    ch: 'M-P',
    engine: 'pair',
    pair: ['chorus', 'chorus'],
    knobs: [RATE, DEPTH, preDelay(500)],
    fixed: { voices: 2, rateR: 1.25 },
    page: 43,
  },
  {
    no: 41,
    code: 'CH/PT',
    name: 'Chorus + Pitch',
    ch: 'M-P',
    engine: 'pair',
    pair: ['chorus', 'pitch'],
    knobs: [RATE, DEPTH, PITCH],
    fixed: { voices: 2 },
    page: 44,
  },
  {
    no: 42,
    code: 'PT/PT',
    name: 'Pitch + Pitch',
    ch: 'M-P',
    engine: 'pair',
    pair: ['pitch', 'pitch'],
    knobs: [
      k('PitL', 'pitch', 'c', -2400, 2400),
      k('PitR', 'pitchR', 'c', -2400, 2400),
      k('PDly', 'pre', 'ms', 0, 500),
    ],
    page: 45,
  },
  {
    no: 43,
    code: 'PT/DL',
    name: 'Pitch + Delay',
    ch: 'M-P',
    engine: 'pair',
    pair: ['pitch', 'delay'],
    knobs: [PITCH, dlyTime('Dly', 'time', 500), k('DlyFB', 'fb', 'fb', -99, 99)],
    fixed: { lpf: 6000 },
    page: 46,
  },
  {
    no: 44,
    code: 'EQ/EQ',
    name: 'EQ + EQ',
    ch: 'M-P',
    engine: 'pair',
    pair: ['eq', 'eq'],
    knobs: [GAIN('LwG', 'low'), GAIN('MdG', 'mid'), GAIN('HiG', 'high')],
    insert: true,
    page: 47,
  },
  {
    no: 45,
    code: 'CP/CP',
    name: 'Comp + Comp',
    ch: 'M-P',
    engine: 'pair',
    pair: ['dynamics', 'dynamics'],
    knobs: [
      k('Sens', 'sens', 'pct', 0, 100),
      k('Atk', 'attack', 'pct', 0, 100),
      k('Rel', 'release', 'pct', 0, 100),
    ],
    insert: true,
    page: 48,
  },
];

/**
 * Extra types for the DPS-V77, whose manual (p.4) says its FX blocks carry effects drawn from the
 * DPS-R7 / D7 / M7 / F7 series. Their ranges follow the DPS-M7 (ring modulator p.47, modulation
 * delay p.40) and DPS-D7 (tap delay p.17) manuals.
 */
export const DPS_EXTRA_FX: FxDef[] = [
  {
    no: 0,
    code: 'Ring',
    name: 'Ring Modulator',
    ch: '2ch',
    engine: 'ringmod',
    knobs: [
      k('Osc', 'osc', 'Hz', 0.05, 3000),
      dlyTime('Dly', 'time', 1000),
      k('FB', 'fb', 'fb', 0, 99),
    ],
    page: 47,
  },
  {
    no: 0,
    code: 'MDly',
    name: 'Modulation Delay',
    ch: '2ch',
    engine: 'moddelay',
    knobs: [dlyTime('Dly', 'time', 500), k('FB', 'fb', 'fb', -99, 99), DEPTH],
    fixed: { rate: 0.3 },
    page: 40,
  },
  {
    no: 0,
    code: 'TapDL',
    name: 'Tap Delay',
    ch: '2ch',
    engine: 'taps',
    knobs: [
      dlyTime('Last', 'time', 1265),
      k('Taps', 'taps', 'x', 2, 38),
      k('Decay', 'decay', 'pct', 0, 100),
    ],
    page: 17,
  },
];

/** The V55 Rate (0–100) as an LFO frequency. Interpretation: the guide prints no Hz. */
export const rateHz = (pct: number) => expKnob(pct, 0.05, 12);

/** A knob position → the value in the guide's units. */
export function knobValue(kn: Knob, v: number): number {
  const x = clamp(v, 0, 1);
  switch (kn.unit) {
    case 's':
    case 'Hz':
      return expKnob(x, kn.min, kn.max);
    case 'ms':
      return kn.min + (kn.max - kn.min) * x * x;
    case 'opt':
      return choice(x, kn.options!.length);
    default:
      return Math.round(lerp(x, kn.min, kn.max) * 10) / 10;
  }
}

/** What the display prints for a knob. */
export function knobText(kn: Knob, v: number): string {
  const n = knobValue(kn, v);
  switch (kn.unit) {
    case 's':
      return `${n.toFixed(n < 10 ? 1 : 0)}s`;
    case 'ms':
      return `${Math.round(n)}ms`;
    case 'Hz':
      return n >= 100 ? `${Math.round(n)}Hz` : `${n.toFixed(1)}Hz`;
    case 'opt':
      return kn.options![n];
    case 'dB':
      return `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
    case 'fb':
    case 'c':
      return `${n > 0 ? '+' : ''}${Math.round(n)}`;
    default:
      return String(Math.round(n));
  }
}

/** Engine inputs for an effect from its three knob positions. */
export function fxValues(def: FxDef, knobs: number[]): Record<string, number> {
  const out: Record<string, number> = { ...def.fixed };
  def.knobs.forEach((kn, i) => {
    const n = knobValue(kn, knobs[i] ?? 0.5);
    switch (kn.unit) {
      case 'ms':
        out[kn.key] = n / 1000;
        break;
      case 'pct':
        out[kn.key] = n / 100;
        break;
      case 'fb':
        out[kn.key] = n / 100;
        break;
      default:
        out[kn.key] = n;
    }
  });
  // Shared conversions: Rate 0–100 → Hz, Hi Damp 0–100 → how fast the highs die.
  if ('rate' in out && out['rate'] <= 1) out['rateHz'] = rateHz(out['rate']);
  if ('hiDamp' in out) out['damp'] = 1 - out['hiDamp'];
  return out;
}

/** The display's three-value readout for a block, e.g. "DlyL 350ms". */
export const knobLine = (def: FxDef, i: number, v: number) =>
  def.knobs[i] ? `${def.knobs[i].name} ${knobText(def.knobs[i], v)}` : '--';
