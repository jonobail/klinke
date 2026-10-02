// DPS-R7 digital reverberator, after the Operating Instructions: front panel (p. 7, items 1–15),
// reverberation parameters (pp. 21–22), the REVS block algorithms with their parameter tables
// and block diagrams (pp. 24–28: HLR, RMR, PLR, GTR, ERF) and the specifications (p. 62: 40 kHz
// sampling, 18-bit converters, 10 Hz–18 kHz).
//
// Each ST-ST algorithm (pp. 24–27) runs: input → presence control → predelay box (predelay 1/2,
// cross predelay, early reflections 1/2, cross early reflections) → reverberation box (reverb
// time, rotate high / bass, size) → spread box → out, with the 2nd early reflections added after
// it. Delay times are in "words", samples at 40 kHz.

import { expMap, faderGain } from '../sound.ts';
import { type GearDef, bi, p, rack, rocker, sel } from '../gear-types.ts';
import { type Tap, type Tail, noise, renderImpulse } from './reverb-ir.ts';

type Params = Record<string, number>;

/** Sampling frequency (p. 62): one "word" of delay is 1 / 40 000 s. */
export const DPS_R7_RATE = 40000;
export const words = (n: number) => n / DPS_R7_RATE;

interface Algorithm {
  code: string;
  name: string;
  /** Reverb (or gate) time range in seconds, from the algorithm's parameter table. */
  time: [number, number];
  /** Longest predelay in words. */
  predelay: number;
  size: [number, number];
  spread: [number, number];
  /** Has the rotate bass filter (HLR, RMR). */
  bass: boolean;
}

/** The five ST-ST algorithms of the REVS block (pp. 24–28). */
export const DPS_R7_ALGORITHMS: Algorithm[] = [
  {
    code: 'HLR',
    name: 'HALL',
    time: [0.3, 99],
    predelay: 32767,
    size: [0.5, 1.5],
    spread: [0.5, 1.5],
    bass: true,
  },
  {
    code: 'RMR',
    name: 'ROOM',
    time: [0.12, 39.6],
    predelay: 32767,
    size: [0.5, 1.5],
    spread: [0.5, 2.5],
    bass: true,
  },
  {
    code: 'PLR',
    name: 'PLATE',
    time: [0.3, 99],
    predelay: 22527,
    size: [0.5, 1.5],
    spread: [0.5, 1.5],
    bass: false,
  },
  // GTR: "gate time 1–16383 words", size and spread 0.5–2.5, predelay up to 30719 words.
  {
    code: 'GTR',
    name: 'GATE',
    time: [words(2000), words(16383)],
    predelay: 30719,
    size: [0.5, 2.5],
    spread: [0.5, 2.5],
    bass: false,
  },
  // ERF: 48 taps per channel; its TIME knob is the pattern's scale (interpretation).
  {
    code: 'ERF',
    name: 'E.REF',
    time: [0.5, 2],
    predelay: 32767,
    size: [0.5, 1.5],
    spread: [0.5, 1.5],
    bass: false,
  },
];

/** GTR envelope forms (p. 27); the envelope time is our multiple of the gate time. */
export const ENVELOPE_FORMS = ['LIN1', 'LIN2', 'EXP1', 'EXP2'];
const ENVELOPE_TIME = [4, 1.5, 4, 1.5];

const pick = (v: number, n: number) => Math.round(v * (n - 1));
const lin = (v: number, [a, b]: [number, number]) => a + (b - a) * v;

export function dpsR7Settings(params: Params) {
  const algo = DPS_R7_ALGORITHMS[pick(params['algo'], DPS_R7_ALGORITHMS.length)];
  const size = lin(params['size'], algo.size);
  const spread = lin(params['spread'], algo.spread);
  return {
    algo,
    index: DPS_R7_ALGORITHMS.indexOf(algo),
    time: expMap(params['time'], algo.time[0], algo.time[1]),
    /** Predelay in words, 1 to the algorithm's maximum, on a square-law knob. */
    predelayWords: Math.round(1 + (algo.predelay - 1) * params['predelay'] ** 2),
    size,
    spread,
    /** Early reflection level, 0–100 %. */
    er: params['er'],
    /** Rotate high, 0.003–1.000: the high band's share of the reverb time. */
    rotateHigh: expMap(params['rotateHigh'], 0.003, 1),
    /** Rotate bass frequency 25 Hz–6.3 kHz. */
    bassHz: expMap(params['bassFreq'], 25, 6300),
    // -12…+6 dB (p. 24); the centre detent is 0 dB, so the two halves of the knob differ.
    bassDb: algo.bass ? (params['bassLevel'] - 0.5) * (params['bassLevel'] < 0.5 ? 24 : 12) : 0,
    envForm: pick(params['envForm'], ENVELOPE_FORMS.length),
    reverse: params['reverse'] >= 0.5,
    dry: faderGain(params['dry']),
    effect: faderGain(params['effect']),
  };
}

export type DpsR7Settings = ReturnType<typeof dpsR7Settings>;

export const dpsR7Key = (s: DpsR7Settings) =>
  [
    s.index,
    s.time.toPrecision(3),
    s.predelayWords,
    s.size.toFixed(2),
    s.spread.toFixed(2),
    s.er.toFixed(2),
    s.rotateHigh.toPrecision(2),
    Math.round(s.bassHz),
    s.bassDb.toFixed(1),
    s.envForm,
    s.reverse,
  ].join();

/**
 * The predelay box's early reflections (pp. 24–26). The parameter tables give each tap 1–32767
 * words, 0–100 % and normal / inverse phase but no factory values: these patterns, scaled by
 * SIZE, are ours. `own` taps stay on their channel, `cross` taps go to the other one.
 */
const ER_MS: Record<string, { own: number[]; cross: number[]; second: number[] }> = {
  HLR: { own: [19, 27], cross: [23, 33], second: [47, 61] },
  RMR: { own: [6, 10], cross: [8, 13], second: [17, 24] },
  PLR: { own: [2.5, 4, 6.5], cross: [3.5, 5.5], second: [9, 12] },
};

export function dpsR7EarlyTaps(s: DpsR7Settings): Tap[] {
  if (s.algo.code === 'ERF') return erfTaps(s);
  const pattern = ER_MS[s.algo.code];
  if (!pattern || s.er <= 0) return [];
  const taps: Tap[] = [];
  const add = (ms: number[], gain: number, cross: boolean) =>
    ms.forEach((m, i) => {
      const t = (m / 1000) * s.size;
      const g = gain * s.er * Math.pow(0.8, i) * (i % 2 ? -1 : 1);
      // ch1 and ch2 each have their own predelay box: one tap per side, mirrored.
      taps.push({ t, gain: g, ch: cross ? 1 : 0 }, { t: t * 1.07, gain: g, ch: cross ? 0 : 1 });
    });
  add(pattern.own, 0.6, false);
  add(pattern.cross, 0.45, true);
  add(pattern.second, 0.35, false);
  return taps;
}

/** ERF (p. 28): 48 taps per channel off a predelayed line; the TIME knob scales the pattern. */
function erfTaps(s: DpsR7Settings): Tap[] {
  const rand = noise(4801);
  const taps: Tap[] = [];
  const pre = words(s.predelayWords);
  for (const ch of [0, 1] as const) {
    for (let i = 0; i < 48; i++) {
      // Spread over ~120 ms (× scale), denser towards the start, falling off with time.
      const x = (i + 0.5 + rand() * 0.45) / 48;
      const t = pre + 0.004 + 0.12 * s.time * s.size * x * x;
      taps.push({ t, gain: (0.9 - 0.75 * x) * (rand() < 0 ? -1 : 1), ch });
    }
  }
  return taps;
}

/** The reverberation box: the decaying (or gated) tail. */
export function dpsR7Tail(s: DpsR7Settings): Tail | null {
  const code = s.algo.code;
  if (code === 'ERF') return null;
  const width = Math.min(1, Math.max(0.15, s.spread - 0.5));
  const start = words(s.predelayWords);
  if (code === 'GTR') {
    // Gate box: the envelope holds for the gate time, then the release cuts it (p. 22 figure).
    const gate = s.time * Math.min(1, s.size);
    const envTime = gate * ENVELOPE_TIME[s.envForm];
    const linear = s.envForm < 2;
    const fall = (t: number) =>
      linear ? Math.max(0, 1 - t / envTime) : Math.exp((-6.9 * t) / envTime);
    return {
      start,
      rt: 2,
      rtHigh: 2 * Math.max(s.rotateHigh, 0.05),
      density: 0.004 * s.size,
      attack: 0.001,
      width,
      shape: s.reverse ? (t) => fall(gate - t) : fall,
      stop: gate,
    };
  }
  const rt = s.time;
  return {
    start,
    rt,
    rtLow: s.algo.bass ? Math.min(99, rt * Math.pow(2, s.bassDb / 6)) : rt,
    rtHigh: Math.max(0.05, rt * s.rotateHigh),
    xLow: s.bassHz,
    xHigh: 5000,
    density: (code === 'PLR' ? 0.004 : code === 'RMR' ? 0.02 : 0.06) * s.size,
    attack: (code === 'PLR' ? 0.002 : code === 'RMR' ? 0.008 : 0.03) * s.size,
    width,
    gain: 1,
  };
}

export const dpsR7Impulse = (s: DpsR7Settings, rate: number) =>
  renderImpulse(rate, dpsR7EarlyTaps(s), dpsR7Tail(s), 7 + s.index);

/** The converters' bandwidth (p. 62: 40 kHz sampling, response to 18 kHz). */
export const DPS_R7_BANDWIDTH = 18000;

const fmtTime = (t: number) =>
  t < 1 ? `${Math.round(t * 1000)}ms` : t < 10 ? `${t.toFixed(2)}s` : `${Math.round(t)}s`;

export const dpsR7: GearDef = rack({
  kind: 'dpsR7',
  label: 'DPS-R7',
  subtitle: 'DIGITAL REVERBERATOR',
  w: 16,
  h: 3,
  params: [
    sel(
      'algo',
      'ALGORITHM',
      DPS_R7_ALGORITHMS.map((a) => `${a.code} ${a.name}`),
      0,
    ),
    p('time', 'TIME', 0.4),
    p('predelay', 'PREDELAY', 0.25),
    p('size', 'SIZE', 0.5),
    p('er', 'E.REF', 0.5),
    p('spread', 'SPREAD', 0.6),
    p('rotateHigh', 'ROT HIGH', 0.85),
    p('bassFreq', 'BASS FREQ', 0.4),
    bi('bassLevel', 'BASS LVL'),
    sel('envForm', 'ENVELOPE', ENVELOPE_FORMS, 0),
    rocker('reverse', 'REVERSE', 'white', false),
    p('input', 'INPUT', 0.75),
    p('dry', 'DRY', 0.75),
    p('effect', 'EFFECT', 0.6),
  ],
  sections: [
    { title: 'ALGORITHM', rows: [['algo'], ['envForm', 'reverse']] },
    {
      title: 'REVERB',
      rows: [
        ['time', 'predelay', 'size'],
        ['er', 'spread'],
      ],
    },
    { title: 'ROTATE', rows: [['rotateHigh'], ['bassFreq', 'bassLevel']] },
    { title: 'LEVEL', rows: [['input'], ['dry', 'effect']] },
  ],
  // The 2 × 40-character display, cut to its first fields.
  display: (params) => {
    const s = dpsR7Settings(params);
    const pre = `${Math.round(words(s.predelayWords) * 1000)}ms`;
    const main = s.algo.code === 'ERF' ? `x${s.time.toFixed(2)}` : fmtTime(s.time);
    return `${s.algo.code} ${s.algo.name}\n${main} PD${pre}`;
  },
  face: { panel: '#1c1d20', text: '#d6d8dc', display: '#9fe870' },
});
