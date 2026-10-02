// REV5 digital reverberator, after the Service Manual: specifications (p. 2), panel layout
// (p. 3) and block diagram (p. 4).
//
// Signal flow (block diagram, p. 4): INPUT L (MONO) / R → INPUT LEVEL → MONO / STEREO switch →
// the two channels summed → analog 3-band EQ (EQ ON switch) → LPF → one A/D channel (16 bit,
// 44.1 kHz) → three YM3804 DSPs with their delay RAMs, the YM3608 DEQ and the MOD generator →
// stereo D/A → LPFs → MIXING (DIRECT ↔ REV) → BYPASS / MUTE → outputs. So the reverb is mono in,
// stereo out, and the EQ colours only the reverb; the direct sound bypasses it.
//
// Front panel (p. 3): INPUT LEVEL, EQ ON / OFF, LO FREQ 50–700 Hz / LEVEL ±15, MID FREQ
// 0.35–5 kHz / LEVEL ±15, HI FREQ 2–20 kHz / LEVEL ±15, MIXING; the direct-recall keys REV1 -31-,
// REV2 -32-, REV3 -33-, REV4 -34-, E/R1 -35-, E/R2 -36-, OTHERS -37-; INITIAL DELAY and 1ST REF
// keys; a 2-digit memory LED and a 16 × 2 LCD.

import { expMap } from '../sound.ts';
import { type GearDef, bi, p, rack, rocker, sel } from '../gear-types.ts';
import { type Tap, type Tail, noise, renderImpulse } from './reverb-ir.ts';

type Params = Record<string, number>;

interface Program {
  key: string;
  name: string;
  /** Kind of impulse: reverb (early reflections + tail), early reflections only, or gated. */
  type: 'rev' | 'er' | 'gate';
  /** Tail build-up, s, and the time before the echoes are dense, s (at DIFFUSION 5). */
  attack: number;
  density: number;
  /** Bass RT multiplier. */
  bass: number;
  /** Early-reflection pattern: spread, s, and taps per channel; `random` scatters them. */
  erSpan: number;
  erTaps: number;
  random?: boolean;
}

/**
 * The direct-recall keys (p. 3). The keys only say REV1–REV4, E/R1, E/R2 and OTHERS; the
 * program names and characters (hall, room, vocal, plate, hall / random reflections, gate for
 * OTHERS) are our interpretation.
 */
export const REV5_PROGRAMS: Program[] = [
  {
    key: 'REV1',
    name: 'HALL',
    type: 'rev',
    attack: 0.05,
    density: 0.09,
    bass: 1.2,
    erSpan: 0.08,
    erTaps: 9,
  },
  {
    key: 'REV2',
    name: 'ROOM',
    type: 'rev',
    attack: 0.012,
    density: 0.03,
    bass: 1,
    erSpan: 0.035,
    erTaps: 8,
  },
  {
    key: 'REV3',
    name: 'VOCAL',
    type: 'rev',
    attack: 0.03,
    density: 0.07,
    bass: 0.8,
    erSpan: 0.05,
    erTaps: 5,
  },
  {
    key: 'REV4',
    name: 'PLATE',
    type: 'rev',
    attack: 0.002,
    density: 0.006,
    bass: 0.9,
    erSpan: 0,
    erTaps: 0,
  },
  {
    key: 'E/R1',
    name: 'HALL',
    type: 'er',
    attack: 0,
    density: 0,
    bass: 1,
    erSpan: 0.12,
    erTaps: 19,
  },
  {
    key: 'E/R2',
    name: 'RANDOM',
    type: 'er',
    attack: 0,
    density: 0,
    bass: 1,
    erSpan: 0.16,
    erTaps: 19,
    random: true,
  },
  {
    key: 'OTHERS',
    name: 'GATE',
    type: 'gate',
    attack: 0.004,
    density: 0.01,
    bass: 1,
    erSpan: 0.03,
    erTaps: 4,
  },
];

/** Sampling frequency and bandwidth of the converters (p. 2). */
export const REV5_RATE = 44100;
/** The analog EQ (p. 2: LOW ±15 dB 50–700 Hz, MID 350 Hz–5 kHz, HIGH 2–20 kHz). */
export const EQ_RANGES = { lo: [50, 700], mid: [350, 5000], hi: [2000, 20000] } as const;

const pick = (v: number, n: number) => Math.round(v * (n - 1));

export function rev5Settings(params: Params) {
  const index = pick(params['program'], REV5_PROGRAMS.length);
  const prog = REV5_PROGRAMS[index];
  const gate = prog.type === 'gate';
  const db = (v: number) => (v - 0.5) * 30;
  return {
    index,
    prog,
    /** Reverb time 0.3–99 s (interpretation); on the gate program, the gate time 30–500 ms. */
    rt: gate ? expMap(params['rt'], 0.03, 0.5) : expMap(params['rt'], 0.3, 99),
    /** HIGH: the high-frequency reverb time as a fraction of RT, 0.1–1.0. */
    high: 0.1 + 0.9 * params['high'],
    /** DIFFUSION 0–10. */
    diffusion: Math.round(params['diffusion'] * 10),
    /** INITIAL DELAY: to the first reflection, 0.1–400 ms (interpretation). */
    initDelay: 0.0001 + 0.3999 * params['initDelay'] ** 2,
    /** 1ST REF: level of the first reflections against the reverb, 0–100 %. */
    firstRef: params['firstRef'],
    eqOn: params['eqOn'] >= 0.5,
    lo: { hz: expMap(params['loFreq'], ...EQ_RANGES.lo), db: db(params['loLevel']) },
    mid: { hz: expMap(params['midFreq'], ...EQ_RANGES.mid), db: db(params['midLevel']) },
    hi: { hz: expMap(params['hiFreq'], ...EQ_RANGES.hi), db: db(params['hiLevel']) },
  };
}

export type Rev5Settings = ReturnType<typeof rev5Settings>;

export const rev5Key = (s: Rev5Settings) =>
  [
    s.index,
    s.rt.toPrecision(3),
    s.high.toFixed(2),
    s.diffusion,
    s.initDelay.toFixed(4),
    s.firstRef.toFixed(2),
  ].join();

/** The early reflections: a regular (hall-like) or scattered pattern after the initial delay. */
export function rev5EarlyTaps(s: Rev5Settings): Tap[] {
  const { prog } = s;
  const level = prog.type === 'er' ? 1 : s.firstRef;
  if (!prog.erTaps || level <= 0) return [];
  const rand = noise(500 + s.index);
  const taps: Tap[] = [];
  for (let i = 0; i < prog.erTaps; i++) {
    const x = prog.random
      ? (i + 0.5 + rand() * 0.5) / prog.erTaps
      : Math.pow((i + 1) / prog.erTaps, 1.4);
    const t = s.initDelay + prog.erSpan * x;
    const g = level * (1 - 0.6 * x) * (prog.random ? 0.6 + 0.4 * Math.abs(rand()) : 1);
    taps.push({ t, gain: (i % 3 === 2 ? -1 : 1) * g * 0.8, ch: (i % 2) as 0 | 1 });
  }
  return taps;
}

/** The reverb tail (none on the E/R programs). */
export function rev5Tail(s: Rev5Settings): Tail | null {
  const { prog } = s;
  if (prog.type === 'er') return null;
  // More diffusion: echoes fill in sooner and the stereo image widens.
  const diff = 2 - s.diffusion * 0.15;
  const width = 0.35 + 0.065 * s.diffusion;
  const start = s.initDelay + prog.erSpan * 0.6;
  if (prog.type === 'gate') {
    return {
      start,
      rt: 2,
      rtHigh: 2 * s.high,
      density: prog.density * diff,
      attack: prog.attack,
      width,
      shape: () => 1,
      stop: s.rt,
    };
  }
  return {
    start,
    rt: s.rt,
    rtLow: s.rt * prog.bass,
    rtHigh: Math.max(0.05, s.rt * s.high),
    xLow: 300,
    xHigh: 3500,
    density: prog.density * diff,
    attack: prog.attack,
    width,
  };
}

export const rev5Impulse = (s: Rev5Settings, rate: number) =>
  renderImpulse(rate, rev5EarlyTaps(s), rev5Tail(s), 50 + s.index);

const ms = (t: number) => (t < 0.01 ? (t * 1000).toFixed(1) : String(Math.round(t * 1000)));

const fmtRt = (s: Rev5Settings) =>
  s.prog.type === 'gate'
    ? `T=${Math.round(s.rt * 1000)}ms`
    : s.prog.type === 'er'
      ? `DLY=${ms(s.initDelay)}ms`
      : `RT=${s.rt < 10 ? s.rt.toFixed(1) : Math.round(s.rt)}s`;

export const rev5: GearDef = rack({
  kind: 'rev5',
  label: 'REV5',
  subtitle: 'DIGITAL REVERBERATOR',
  w: 17,
  h: 3,
  params: [
    sel(
      'program',
      'PROGRAM',
      REV5_PROGRAMS.map((x) => `${x.key} ${x.name}`),
      0,
    ),
    p('rt', 'RT', 0.3),
    p('high', 'HIGH', 0.55),
    p('diffusion', 'DIFFUSION', 0.8),
    p('initDelay', 'INIT DLY', 0.25),
    p('firstRef', '1ST REF', 0.5),
    p('input', 'INPUT', 0.75),
    rocker('eqOn', 'EQ ON', 'white', false),
    p('loFreq', 'LO F', 0.4),
    bi('loLevel', 'LO'),
    p('midFreq', 'MID F', 0.5),
    bi('midLevel', 'MID'),
    p('hiFreq', 'HI F', 0.4),
    bi('hiLevel', 'HI'),
    p('mix', 'MIXING', 0.45),
  ],
  sections: [
    { title: 'MEMORY', rows: [['program'], ['initDelay', 'firstRef']] },
    { title: 'PARAMETER', rows: [['rt', 'high', 'diffusion']] },
    { title: 'INPUT', rows: [['input'], ['eqOn']] },
    {
      title: 'EQ',
      rows: [
        ['loFreq', 'midFreq', 'hiFreq'],
        ['loLevel', 'midLevel', 'hiLevel'],
      ],
    },
    { title: 'OUTPUT', rows: [['mix']] },
  ],
  // The MEMORY LED and the first LCD line, then the parameter being edited.
  display: (params) => {
    const s = rev5Settings(params);
    return `${String(s.index + 1).padStart(2, '0')} ${s.prog.key} ${s.prog.name}\n${fmtRt(s)}`;
  },
  face: { panel: '#16171a', text: '#d9dade', display: '#ffb347' },
});
