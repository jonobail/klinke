// MODEL 200 digital reverb, after the Service Packet: the specifications (§1.2, p. 1-2), the
// block diagram (§1.3, p. 1-4), the front panel (Fig. 4.1, p. 4-2) and the Test Report Addendum
// 010-04139 (pp. 4–6: variations, "How the controls affect the sound").
//
// Signal flow (block diagram): input mix → input filter → A/D → digital reverberation processor
// → D/A → output filter → OUTPUT MIX with the direct signal. The reverb is band-limited by "very
// sharp antialiasing filters at 10 kHz"; the direct signal keeps its full 20 kHz.
//
// Controls (Fig. 4.1): PROGRAM / REGISTER keypad, PREDELAY (ms), REVERB TIME (s) and SIZE (m)
// knobs with 7-segment readouts, PRE-ECHOES on, DIFFUSION high / med / low, RT CONTOUR low
// (×1.5 / ×1 / ×.5) and high (×1 / ×.5 / ×.25), ROLLOFF low / med / high.

import { expMap } from '../sound.ts';
import { type GearDef, p, rack, rocker, sel } from '../gear-types.ts';
import { type Tap, type Tail, lowPass, renderImpulse } from './reverb-ir.ts';

type Params = Record<string, number>;

interface Program {
  name: string;
  /** For the display (≤ 6 characters). */
  short: string;
  /** Largest SIZE in metres: "maximum values range from 40 to 99 meters (program-dependent)". */
  sizeMax: number;
  /** Built-in predelay, s: "Program 1 (Halls) has a minimum of 23 milliseconds". */
  minPre: number;
  /** Echo build-up time at full size, s (how long the reflections take to fill in). */
  density: number;
  /** Level rise at full size, s. */
  attack: number;
  /** Stereo decorrelation of the tail. */
  width: number;
  /** Multiplies the low-band RT (a "rich" program holds its bass longer). */
  bass: number;
  /** Reversed envelope: the tail swells and stops (Inverse Room). */
  inverse?: boolean;
}

/**
 * The six programs of the Addendum ("Each of the six programs in the M200 has up to 10
 * variations"). Only "Program 1 (Halls)" and "the Inverse Room program" are named there; the
 * other names and all the numbers are our interpretation (see docs/devices/model200.md).
 */
export const MODEL200_PROGRAMS: Program[] = [
  {
    name: 'HALL',
    short: 'HALL',
    sizeMax: 99,
    minPre: 0.023,
    density: 0.12,
    attack: 0.06,
    width: 0.9,
    bass: 1,
  },
  {
    name: 'PLATE',
    short: 'PLATE',
    sizeMax: 40,
    minPre: 0,
    density: 0.012,
    attack: 0.002,
    width: 0.8,
    bass: 0.9,
  },
  {
    name: 'CHAMBER',
    short: 'CHAMBR',
    sizeMax: 70,
    minPre: 0,
    density: 0.06,
    attack: 0.025,
    width: 0.75,
    bass: 1,
  },
  {
    name: 'RICH PLATE',
    short: 'R.PLAT',
    sizeMax: 40,
    minPre: 0,
    density: 0.008,
    attack: 0.004,
    width: 0.95,
    bass: 1.3,
  },
  {
    name: 'INVERSE ROOM',
    short: 'INVRS',
    sizeMax: 60,
    minPre: 0,
    density: 0.03,
    attack: 0.001,
    width: 0.85,
    bass: 1,
    inverse: true,
  },
  {
    name: 'ROOM',
    short: 'ROOM',
    sizeMax: 40,
    minPre: 0,
    density: 0.025,
    attack: 0.008,
    width: 0.7,
    bass: 1,
  },
];

/**
 * The variation keypad (Addendum p. 4): rows set the size of the space (1–3 and 0 large, 4–6
 * medium, 7–9 small), columns the reverb time and pre-echoes (1/4/7 medium RT, no pre-echoes;
 * 2/5/8 medium RT, medium pre-echoes; 3/6/9 short RT, high pre-echoes). Variation 0 is 1 "more
 * metallic" (we take that as 1 without the random modulation).
 */
export function variation(v: number) {
  const col = v === 0 ? 0 : (v - 1) % 3;
  const row = v === 0 ? 0 : Math.floor((v - 1) / 3);
  return {
    preEcho: [0, 0.5, 1][col],
    rtScale: col === 2 ? 0.6 : 1,
    spacing: [1, 0.6, 0.35][row],
    metallic: v === 0,
  };
}

const DIFFUSION = ['LOW', 'MED', 'HIGH'];
const CONTOUR_LOW = [1.5, 1, 0.5];
const CONTOUR_HIGH = [1, 0.5, 0.25];
/** ROLLOFF: 6 dB/octave "at 7 kHz and 3 kHz" (MED, LOW); HIGH is only the 10 kHz anti-alias. */
const ROLLOFF_HZ = [3000, 7000, 0];
/** The reverb's band limit, "very sharp antialiasing filters at 10 kHz". */
export const MODEL200_BANDWIDTH = 10000;

const pick = (v: number, n: number) => Math.round(v * (n - 1));

export function model200Settings(params: Params) {
  const prog = MODEL200_PROGRAMS[pick(params['program'], MODEL200_PROGRAMS.length)];
  const varNo = pick(params['variation'], 10);
  const vari = variation(varNo);
  const size = Math.round(expMap(params['size'], 8, prog.sizeMax));
  // "Maximum values range from 39 to 999 milliseconds (program- and size-dependent)": we let the
  // ceiling grow with the size, from 39 ms in the smallest space to 999 ms in a 99 m hall.
  const preMax = 0.039 + (0.96 * (size - 8)) / (99 - 8);
  const predelay = prog.minPre + Math.max(0, preMax - prog.minPre) * params['predelay'] ** 2;
  // "Adjustable from approximately 0.6 to 70 seconds (program- and size-dependent)"; "in all but
  // the Inverse Room program, REVERB TIME can be affected by the SIZE control".
  const knobRt = expMap(params['rt'], 0.6, 70);
  const rt = prog.inverse
    ? expMap(params['rt'], 0.1, 1.5)
    : Math.min(70, Math.max(0.6, knobRt * (0.4 + (0.6 * size) / prog.sizeMax) * vari.rtScale));
  const diffusion = pick(params['diffusion'], 3);
  return {
    program: MODEL200_PROGRAMS.indexOf(prog) + 1,
    prog,
    variation: varNo,
    vari,
    size,
    predelay,
    rt,
    preEchoes: params['preEchoes'] >= 0.5 && vari.preEcho > 0,
    diffusion,
    rtLow: CONTOUR_LOW[pick(params['contourLow'], 3)],
    rtHigh: CONTOUR_HIGH[pick(params['contourHigh'], 3)],
    rolloffHz: ROLLOFF_HZ[pick(params['rolloff'], 3)],
    /** Depth of the tail's random pitch modulation, s (none on the "metallic" variation 0). */
    modDepth: vari.metallic ? 0 : 0.0004,
  };
}

export type Model200Settings = ReturnType<typeof model200Settings>;

/** Everything that changes the impulse (the knobs move it only when this changes). */
export const model200Key = (s: Model200Settings) =>
  [
    s.program,
    s.variation,
    s.size,
    s.predelay.toFixed(3),
    s.rt.toFixed(2),
    s.preEchoes,
    s.diffusion,
    s.rtLow,
    s.rtHigh,
    s.rolloffHz,
  ].join();

/**
 * Pre-echoes "emulate stage reflections. They are independent of the PREDELAY setting and may
 * arrive before the predelayed sound." Our pattern: floor and stage reflections, alternating
 * sides, spread out by the variation's row (the size of the space).
 */
export function model200PreEchoes(s: Model200Settings): Tap[] {
  if (!s.preEchoes) return [];
  const ms = s.vari.preEcho >= 1 ? [9, 14, 21, 29, 38] : [12, 19, 31];
  const scale = s.vari.spacing * (0.5 + (0.5 * s.size) / s.prog.sizeMax);
  return ms.map((m, i) => ({
    t: (m / 1000) * scale * 2,
    gain: 0.35 * s.vari.preEcho * Math.pow(0.85, i),
    ch: (i % 2) as 0 | 1,
  }));
}

/** The reverberant tail for these settings. */
export function model200Tail(s: Model200Settings): Tail {
  const sz = s.size / 99;
  // HIGH diffusion fills in fastest ("blends the reflections together"); LOW leaves them discrete.
  const diff = [2.5, 1, 0.45][s.diffusion] * (s.vari.metallic ? 1.6 : 1);
  const tail: Tail = {
    start: s.predelay,
    rt: s.rt,
    rtLow: s.rt * s.rtLow * s.prog.bass,
    rtHigh: s.rt * s.rtHigh,
    xLow: 250,
    xHigh: 3000,
    density: 0.003 + s.prog.density * Math.sqrt(sz) * diff,
    attack: s.prog.attack * Math.sqrt(sz),
    width: s.prog.width,
  };
  if (s.prog.inverse) {
    // The swell rises over the reverb time and stops dead.
    const len = s.rt;
    tail.shape = (t) => Math.pow(Math.min(t / len, 1), 1.6);
    tail.stop = len;
    tail.rtLow = tail.rtHigh = undefined;
  }
  return tail;
}

/** The stereo impulse response, with the ROLLOFF filter applied. */
export function model200Impulse(s: Model200Settings, rate: number) {
  const ir = renderImpulse(
    rate,
    model200PreEchoes(s),
    model200Tail(s),
    s.program * 11 + s.variation,
  );
  if (s.rolloffHz) lowPass(ir, s.rolloffHz, rate);
  return ir;
}

const fmtRt = (rt: number) => (rt < 10 ? rt.toFixed(1) : String(Math.round(rt)));

export const model200: GearDef = rack({
  kind: 'model200',
  label: 'MODEL 200',
  subtitle: 'DIGITAL REVERBERATOR',
  w: 15,
  h: 3,
  params: [
    sel(
      'program',
      'PROGRAM',
      MODEL200_PROGRAMS.map((x, i) => `${i + 1} ${x.name}`),
      0,
    ),
    sel('variation', 'VARIATION', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 1),
    p('predelay', 'PREDELAY', 0.15),
    p('rt', 'RVB TIME', 0.35),
    p('size', 'SIZE', 0.75),
    rocker('preEchoes', 'PRE-ECHO', 'white', false),
    sel('diffusion', 'DIFFUSION', DIFFUSION, 2),
    sel('contourLow', 'RT LOW', ['×1.5', '×1', '×.5'], 1),
    sel('contourHigh', 'RT HIGH', ['×1', '×.5', '×.25'], 1),
    sel('rolloff', 'ROLLOFF', ['LOW', 'MED', 'HIGH'], 1),
    p('mix', 'MIX', 0.45),
  ],
  sections: [
    { title: 'PROGRAM', rows: [['program'], ['variation']] },
    {
      title: 'REVERBERATION',
      rows: [
        ['predelay', 'rt'],
        ['size', 'preEchoes'],
      ],
    },
    {
      title: 'CONTOUR',
      rows: [
        ['diffusion', 'rolloff'],
        ['contourLow', 'contourHigh'],
      ],
    },
    { title: 'OUTPUT', rows: [['mix']] },
  ],
  // The PROG.REG window and the PREDELAY / REVERB TIME / SIZE readouts.
  display: (params) => {
    const s = model200Settings(params);
    const line1 = `${s.program}.${s.variation} ${s.prog.short}`;
    return `${line1}\n${Math.round(s.predelay * 1000)}ms ${fmtRt(s.rt)}s ${s.size}m`;
  },
  face: { panel: '#2b2d31', text: '#e8e4d8', display: '#ff3b2f' },
});
