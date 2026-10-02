// DPS-D7 digital delay, after its Operating Instructions ("Parameters of Each Block", pp.11–22).
//
// Signal flow (p.12): INPUT → EQ → DELAY → AUTO PAN → OUTPUT. The delay block runs one of seven
// algorithms (pp.15–20), with their time ranges:
//
//   1 STD Stereo Delay      two lines, time only, 0–1365.31 ms
//   2 FBD Feedback Delay    two lines with feedback level / phase and a bass + treble loop EQ
//   3 DBD Double Delay      pre delay (≤ 682.63 ms) into main delay (≤ 682.44 ms), each with feedback
//   4 TPD Tap Delay         38 taps per channel up to 1265.31 ms after a ≤ 99.98 ms pre delay
//   5 LGD Long Tap Delay    one 2730.44 ms line, 3-band loop EQ, 29 taps per channel
//   6 PTD Panpot Tap Delay  pre delay with feedback into a main delay with five panned taps
//   7 MTD Multi-Delay       cross-coupled channels: early reflections, taps, cross feedback
//
// The panel has INPUT, DRY and EFFECT knobs and an operating dial (p.8). The dial's parameter
// pages become knobs here: TIME and TIME 2 (what each sets depends on the algorithm, listed in
// `D7_ALGOS`), FEEDBK (level, with the left half the "inverse" phase), BASS / TREBLE (the loop
// EQ, or the EQ block for the algorithms without feedback), and the auto panner (p.21): wave
// (or OFF), frequency 0.1–20 Hz and width (limit min / max).

import { LFO_WAVES, bipolar, choice, expKnob, fmtMs, fmtSigned, timeKnob } from './dps-dsp.ts';
import { type GearDef, bi, p, rack, sel } from '../gear-types.ts';

type Params = Record<string, number>;

export interface D7Algo {
  code: string;
  name: string;
  /** TIME knob: what it sets and its range (seconds). */
  time: number;
  /** TIME 2 knob: what it sets (for the display) and its range. */
  time2: number;
  label2: string;
  /** Has a feedback loop (FEEDBK and the loop EQ apply). */
  feedback: boolean;
  page: number;
}

export const D7_ALGOS: D7Algo[] = [
  {
    code: 'STD',
    name: 'STEREO DELAY',
    time: 1.36531,
    time2: 1.36531,
    label2: 'R',
    feedback: false,
    page: 15,
  },
  {
    code: 'FBD',
    name: 'FEEDBACK DELAY',
    time: 1.36521,
    time2: 1.36521,
    label2: 'R',
    feedback: true,
    page: 15,
  },
  {
    code: 'DBD',
    name: 'DOUBLE DELAY',
    time: 0.68263,
    time2: 0.68244,
    label2: 'D2',
    feedback: true,
    page: 16,
  },
  {
    code: 'TPD',
    name: 'TAP DELAY',
    time: 1.26531,
    time2: 0.09998,
    label2: 'PD',
    feedback: false,
    page: 17,
  },
  {
    code: 'LGD',
    name: 'LONG TAP DELAY',
    time: 2.73044,
    time2: 0.68,
    label2: 'SP',
    feedback: true,
    page: 18,
  },
  {
    code: 'PTD',
    name: 'PANPOT TAP DELAY',
    time: 0.68265,
    time2: 0.6826,
    label2: 'PD',
    feedback: true,
    page: 19,
  },
  {
    code: 'MTD',
    name: 'MULTI-DELAY',
    time: 0.68265,
    time2: 0.68265,
    label2: 'R',
    feedback: true,
    page: 20,
  },
];

/** Shortest delay on the lines with feedback: 0.021 ms (pp.15–20). */
const MIN_FB_TIME = 0.000021;
/** The loop / EQ-block shelving gain range, ±12 dB (pp.14–15). */
export const EQ_DB = 12;
/** Shelf corners. The manual's are adjustable (bass 25 Hz–6.3 kHz, treble 400 Hz–20 kHz); ours are fixed. */
export const D7_SHELF_HZ = { bass: 200, treble: 4000 };

export function d7Settings(p: Params) {
  const index = choice(p['algo'], D7_ALGOS.length);
  const algo = D7_ALGOS[index];
  const min = algo.feedback ? MIN_FB_TIME : 0;
  const pan = choice(p['pan'], LFO_WAVES.length + 1);
  return {
    index,
    algo,
    time: timeKnob(p['time'], algo.time, min),
    time2: timeKnob(p['time2'], algo.time2, min),
    /** Feedback level 0–100 % with phase: negative is "inverse". */
    feedback: bipolar(p['feedback']),
    bassDb: bipolar(p['bass']) * EQ_DB,
    trebleDb: bipolar(p['treble']) * EQ_DB,
    /** Auto panner: -1 off, else the LFO wave (sin, triangle, special 1, special 2). */
    panWave: pan - 1,
    panHz: expKnob(p['panRate'], 0.1, 20),
    panWidth: p['panWidth'],
  };
}

export const dpsD7: GearDef = rack({
  kind: 'dpsD7',
  label: 'DPS-D7',
  subtitle: 'DIGITAL DELAY',
  w: 15,
  h: 3,
  params: [
    p('input', 'INPUT', 0.75),
    sel(
      'algo',
      'ALGO',
      D7_ALGOS.map((a, i) => `${i + 1} ${a.code}`),
      1,
    ),
    p('time', 'TIME', 0.55),
    p('time2', 'TIME 2', 0.35),
    bi('feedback', 'FDBK', 0.7),
    bi('bass', 'BASS'),
    bi('treble', 'TREBLE', 0.4),
    sel('pan', 'PAN', ['OFF', ...LFO_WAVES], 0),
    p('panRate', 'RATE', 0.35),
    p('panWidth', 'WIDTH', 0.8),
    p('dry', 'DRY', 0.75),
    p('effect', 'EFFECT', 0.6),
  ],
  sections: [
    { title: 'INPUT', rows: [['input']] },
    {
      title: 'DELAY',
      rows: [
        ['algo', 'time'],
        ['time2', 'feedback'],
      ],
    },
    { title: 'EQ', rows: [['bass', 'treble']] },
    { title: 'AUTO PAN', rows: [['pan', 'panRate', 'panWidth']] },
    { title: 'OUTPUT', rows: [['dry', 'effect']] },
  ],
  display: (params) => {
    const s = d7Settings(params);
    const t2 = Math.round(s.time2 * 1000);
    const fb = `${s.algo.code === 'TPD' ? 'SL' : 'FB'}${fmtSigned(Math.round(s.feedback * 100))}`;
    const second = s.algo.code === 'STD' ? `R ${fmtMs(s.time2)}` : `${s.algo.label2}${t2} ${fb}`;
    return `${s.index + 1} ${s.algo.code} ${fmtMs(s.time)}\n${second}`;
  },
  face: { panel: '#26272b', text: '#e6e4dc', display: '#7fe7ff' },
});
