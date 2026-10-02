// DPS-M7 digital sonic modulator, after its Operating Instructions ("Parameters of Each Block",
// pp.10–53).
//
// Signal flow (p.11): INPUT → PRE-EFFECT 1 → PRE-EFFECT 2 → MODULATION → POST-EFFECT → OUTPUT,
// with the ENVELOPE block following the input and driving the modulation block. Every block has
// an "Algorithm 0" that passes the signal through. The modulation block has twenty algorithms
// (table of contents p.4, pp.23–48), listed in `M7_ALGOS`.
//
// The unit is edited from a dial and EDIT pages; here the main parameters of the modulation
// algorithms become knobs: RATE (LFO frequency 0.01–40 Hz), DEPTH, DELAY (predelay / manual /
// main delay, per algorithm), FEEDBK (feedback or resonance level, left half "inverse"), PITCH
// (±2400 cents for the pitch shifters), WAVE (sin / triangle / special 1 / special 2, p.23),
// PHASE (the ch2 LFO phase, 0–359°) and ENV, the envelope block's "effect modulation" (p.18,
// "dynamic modulation"): the input's envelope raises (+) or ducks (−) the effect level. One
// pre-effect slot (pp.13–17) with a single AMOUNT knob, and MIX / OUTPUT.

import { LFO_WAVES, bipolar, choice, expKnob, fmtHz, fmtSigned, pad } from './dps-dsp.ts';
import { type GearDef, bi, p, rack, sel } from '../gear-types.ts';

type Params = Record<string, number>;

export interface M7Algo {
  code: string;
  name: string;
  /** What the DELAY knob sets, and its top (seconds), or '' if unused. */
  delay: string;
  delayMax: number;
  page: number;
}

const a = (code: string, name: string, delay: string, delayMax: number, page: number): M7Algo => ({
  code,
  name,
  delay,
  delayMax,
  page,
});

export const M7_ALGOS: M7Algo[] = [
  a('OFF', 'EFFECT OFF', '', 0, 23),
  a('SCH', 'STEREO CHORUS', 'PRE', 0.3, 23),
  a('DCH', 'DECA CHORUS', 'PRE', 1.0, 24),
  a('MCH', 'MULTI CHORUS', 'PRE', 0.3, 25),
  a('BCH', 'BAND CHORUS', 'PRE', 0.3, 26),
  a('SPS', 'STEREO PITCH', 'PRE', 0.5, 30),
  a('BPS', 'BAND PITCH', 'PRE', 0.5, 31),
  a('PSM', 'PITCH MOD', 'PRE', 0.5, 32),
  a('RVS', 'REVERSE SHIFT', 'LEN', 0.65, 33),
  a('ENS', 'ENSEMBLE', 'PRE', 0.3, 34),
  a('MPH', 'MULTI PHASER', 'MAN', 1, 35),
  a('SFL', 'STEREO FLANGER', 'MAN', 0.02, 36),
  a('MFL', 'MULTI FLANGER', 'MAN', 0.02, 38),
  a('MDL', 'MOD DELAY', 'DLY', 0.5, 40),
  a('SPM', 'SPIRAL MOD', 'PRE', 0.3, 41),
  a('SPA', 'STEREO PANNER', '', 0, 42),
  a('HPA', 'HAAS PANNER', '', 0, 43),
  a('DOP', 'DOPPLER', 'DIST', 0.02, 44),
  a('VIB', 'VIBRATO+TREM', 'PRE', 0.5, 45),
  a('RNG', 'RING MOD', 'DLY', 1.0, 47),
  a('RTY', 'ROTARY', '', 0, 48),
];

/** Pre-effect 1 / 2 algorithms (pp.13–17). */
export const M7_PRE = ['OFF', 'SEQ', 'SXE', 'DEX', 'GTE', 'CMP'] as const;

/** Rotary speaker: below half the RATE knob is SLOW, above is FAST (p.48 "speed select"). */
export const rotaryFast = (rate: number) => rate >= 0.5;

export function m7Settings(p: Params) {
  const index = choice(p['algo'], M7_ALGOS.length);
  const algo = M7_ALGOS[index];
  return {
    index,
    algo,
    /** LFO frequency 0.01–40 Hz (pp.23–48). */
    rateHz: expKnob(p['rate'], 0.01, 40),
    /** Ring modulator oscillator, 0.05–3000 Hz (p.47). */
    oscHz: expKnob(p['rate'], 0.05, 3000),
    fast: rotaryFast(p['rate']),
    depth: p['depth'],
    /** The DELAY knob's value in seconds for this algorithm (square law). */
    delay: algo.delayMax * p['delay'] * p['delay'],
    delayKnob: p['delay'],
    feedback: bipolar(p['feedback']) * 0.999,
    pitch: Math.round(bipolar(p['pitch']) * 2400),
    wave: choice(p['wave'], 4),
    phase: Math.round(p['phase'] * 359),
    env: bipolar(p['env']),
    pre: M7_PRE[choice(p['pre'], M7_PRE.length)],
    preAmount: p['preAmt'],
  };
}

export const dpsM7: GearDef = rack({
  kind: 'dpsM7',
  label: 'DPS-M7',
  subtitle: 'DIGITAL SONIC MODULATOR',
  w: 17,
  h: 3,
  params: [
    p('input', 'INPUT', 0.75),
    sel('pre', 'PRE FX', [...M7_PRE], 0),
    p('preAmt', 'AMOUNT', 0.5),
    sel(
      'algo',
      'ALGO',
      M7_ALGOS.map((x, i) => `${pad(i)} ${x.code}`),
      1,
    ),
    p('rate', 'RATE', 0.45),
    p('depth', 'DEPTH', 0.4),
    p('delay', 'DELAY', 0.3),
    bi('feedback', 'FDBK', 0.5),
    bi('pitch', 'PITCH', 0.5),
    sel('wave', 'WAVE', [...LFO_WAVES], 0),
    p('phase', 'PHASE', 0.5),
    bi('env', 'ENV', 0.5),
    p('mix', 'MIX', 0.5),
    p('output', 'OUTPUT', 0.75),
  ],
  sections: [
    { title: 'INPUT', rows: [['input'], ['pre', 'preAmt']] },
    {
      title: 'MODULATION',
      rows: [
        ['algo', 'rate', 'depth', 'delay'],
        ['feedback', 'pitch', 'wave', 'phase'],
      ],
    },
    { title: 'OUTPUT', rows: [['env'], ['mix', 'output']] },
  ],
  display: (params) => {
    const s = m7Settings(params);
    const c = s.algo.code;
    let second: string;
    if (c === 'OFF') second = 'THRU';
    else if (c === 'RTY') second = s.fast ? 'FAST' : 'SLOW';
    else if (c === 'RNG') second = `OSC ${fmtHz(s.oscHz)}`;
    else if (['SPS', 'BPS', 'PSM', 'RVS'].includes(c)) second = `${fmtSigned(s.pitch)}c`;
    else second = `${fmtHz(s.rateHz)} D${Math.round(s.depth * 100)}`;
    return `${pad(s.index)} ${c}\n${second}`;
  },
  face: { panel: '#232428', text: '#e4e2da', display: '#ffb347' },
});
