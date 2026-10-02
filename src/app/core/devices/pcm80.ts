// PCM-80 digital effects processor, after the service manual:
// p. 1-1 block diagram — stereo analog (or S/PDIF) input → INPUT level → EFFECTS → MIX of dry and
// effect → D/A, with the CPU taking the soft knob, keys, footswitch and foot controller;
// p. 1-2 front panel — INPUT, a two-row 20-character display (effect names and parameter values),
// ADJUST ("with Program Banks selected, behaves as a soft knob for patched parameters"), SELECT,
// four internal preset banks of 50 programs, TEMPO and TAP ("press twice in rhythm to establish
// tempo rate"); p. 2-1 / 2-2 specifications (10 Hz–20 kHz, 18-bit conversion, 18–24-bit DSP,
// two 256k × 18 DRAMs of audio memory); p. 3-7 the Concert Hall program "UpMyEchos" (P0 1.9) and
// the ADJUST soft-knob patch shown on the display; p. 3-9 the "S.0 Controls Mix" edit row.
//
// The service manual names only the Concert Hall algorithm. The other algorithm families here are
// our interpretation of the PCM-80's effects set (see docs/devices/pcm80.md).

import { expMap } from '../sound.ts';
import { type GearDef, p, rack, sel } from '../gear-types.ts';
import { focusTracker } from './pcm-display.ts';
import {
  CHORDS,
  type ChordSettings,
  NOTE_VALUES,
  type ReverbSettings,
  type RoomShape,
  type TapSettings,
  beatSeconds,
  fmtDb,
  fmtHz,
  fmtTime,
  knobBpm,
  noteLabel,
  pct,
  pick,
} from './pcm-dsp.ts';

type Params = Record<string, number>;

export interface Pcm80Algorithm {
  name: string;
  /** As the display spells it (≤ 12 characters). */
  short: string;
  /** What ADJUST is patched to in this algorithm's programs. */
  adjust: string;
}

export const PCM80_ALGORITHMS: Pcm80Algorithm[] = [
  { name: 'CONCERT HALL', short: 'ConcertHall', adjust: 'ECHOES' },
  { name: 'PLATE', short: 'Plate', adjust: 'BLOOM' },
  { name: 'CHORUS-VERB', short: 'ChorusVerb', adjust: 'VERB' },
  { name: 'INVERSE', short: 'Inverse', adjust: 'SLOPE' },
  { name: 'DUAL CHORUS', short: 'DualChorus', adjust: 'SWIRL' },
  { name: 'MULTI-BAND DELAY', short: 'MultiBand', adjust: 'BANDS' },
  { name: 'DUAL DELAY', short: 'DualDelay', adjust: 'WIDTH' },
  { name: 'RES-CHORD', short: 'Res-Chord', adjust: 'CHORD' },
];

export const pcm80Algorithm = (p: Params) => Math.round(p['algo'] * (PCM80_ALGORITHMS.length - 1));

export type Pcm80Settings =
  | { algo: number; kind: 'reverb'; reverb: ReverbSettings }
  | { algo: number; kind: 'chorusVerb'; taps: TapSettings; reverb: ReverbSettings; verb: number }
  | { algo: number; kind: 'taps'; taps: TapSettings }
  | { algo: number; kind: 'chords'; chords: ChordSettings };

/** TEMPO and the note value: the length of one delay step in seconds. */
export const pcm80Unit = (p: Params) =>
  beatSeconds(knobBpm(p['tempo']), pick(p['div'], NOTE_VALUES).beats);

function room(p: Params, shape: RoomShape, maxRt: number, rtScale = 1): ReverbSettings {
  const size = expMap(p['size'], 4, 40);
  return {
    room: {
      shape,
      rt:
        shape === 'inverse' ? expMap(p['decay'], 0.1, 1) : expMap(p['decay'], 0.3, maxRt) * rtScale,
      bassMult: 1.2,
      trebleHz: expMap(p['tone'], 1000, 20000),
      size,
      slope: 6 + 30 * p['adjust'],
    },
    // Bigger rooms open with a longer gap before the first reflections.
    predelay: shape === 'inverse' ? 0 : size / 343 / 2,
    depth: 0.002 * p['depth'],
    rate: expMap(p['rate'], 0.05, 4),
  };
}

export function pcm80Settings(p: Params): Pcm80Settings {
  const algo = pcm80Algorithm(p);
  const adj = p['adjust'];
  const step = pcm80Unit(p);
  const toneHz = expMap(p['tone'], 1000, 20000);
  const rate = expMap(p['rate'], 0.05, 8);
  const feedback = 0.95 * p['decay'];
  switch (algo) {
    case 0: {
      // ADJUST brings up tempo echoes that feed the hall ("UpMyEchos", p. 3-7).
      const r = room(p, 'hall', 20);
      return {
        algo,
        kind: 'reverb',
        reverb: { ...r, echo: { time: step, level: adj, feedback: 0.35 } },
      };
    }
    case 1: {
      // BLOOM lengthens the plate and opens its top together.
      const r = room(p, 'plate', 10, 0.6 + 1.2 * adj);
      r.room.trebleHz = Math.min(20000, r.room.trebleHz * (0.7 + 0.8 * adj));
      r.predelay = 0;
      return { algo, kind: 'reverb', reverb: r };
    }
    case 2: {
      const base = expMap(p['size'], 0.006, 0.03);
      return {
        algo,
        kind: 'chorusVerb',
        verb: adj,
        reverb: room({ ...p, size: 0.3 }, 'chamber', 6),
        taps: {
          taps: [
            { time: base, pan: -1, phase: 0, band: 0, send: 1 },
            { time: base * 1.4, pan: 1, phase: 0.5, band: 0, send: 1 },
          ],
          topology: 'self',
          feedback: 0.3 * p['decay'],
          toneHz,
          depth: Math.min(0.006 * p['depth'], base * 0.8),
          rate,
          diffusion: 0,
        },
      };
    }
    case 3:
      return { algo, kind: 'reverb', reverb: room(p, 'inverse', 1) };
    case 4: {
      // SWIRL deepens and quickens all six voices at once.
      const base = expMap(p['size'], 0.005, 0.04);
      const ms = [1, 1.21, 1.47, 1.1, 1.33, 1.62];
      return {
        algo,
        kind: 'taps',
        taps: {
          taps: ms.map((m, i) => ({
            time: base * m,
            pan: i < 3 ? -1 + i * 0.3 : 1 - (i - 3) * 0.3,
            phase: i / 6,
            band: 0,
            send: 1,
          })),
          topology: 'self',
          feedback: 0.5 * p['decay'],
          toneHz,
          depth: Math.min(0.008 * Math.min(1, p['depth'] * (0.5 + adj)), base * 0.8),
          rate: rate * (0.5 + adj),
          diffusion: 0,
        },
      };
    }
    case 5: {
      // Six taps on the tempo grid, each in its own band; BANDS narrows them.
      const n = 6;
      return {
        algo,
        kind: 'taps',
        taps: {
          taps: Array.from({ length: n }, (_, i) => ({
            time: step * (1 + i * p['size']),
            pan: i % 2 ? 0.8 : -0.8,
            phase: i / n,
            band: 300 * Math.pow(16, i / (n - 1)),
            send: 1,
          })),
          topology: 'self',
          feedback,
          toneHz,
          depth: Math.min(0.002 * p['depth'], step * 0.5),
          rate,
          diffusion: 0,
          bandQ: 0.7 + 7 * adj,
        },
      };
    }
    case 6: {
      // Left on the step, right later by SIZE, bouncing through each other; WIDTH spreads them.
      const times = [step, step * (1 + p['size'])];
      return {
        algo,
        kind: 'taps',
        taps: {
          taps: times.map((time, i) => ({
            time,
            pan: (i ? 1 : -1) * adj,
            phase: i / 2,
            band: 0,
            send: i ? 0 : 1,
          })),
          topology: 'ring',
          feedback,
          toneHz,
          depth: Math.min(0.002 * p['depth'], step * 0.5),
          rate,
          diffusion: 0,
        },
      };
    }
    default:
      return {
        algo,
        kind: 'chords',
        chords: {
          root: 24 + Math.round(p['size'] * 36),
          steps: pick(adj, CHORDS).steps,
          decay: expMap(p['decay'], 0.2, 8),
          toneHz: expMap(p['tone'], 800, 12000),
          detune: 25 * p['depth'],
          width: 0.8,
          strum: 0.08 * p['rate'],
        },
      };
  }
}

/** The display's second row: the control being changed, in the algorithm's own terms. */
export function pcm80Readout(p: Params, id: string): string {
  const s = pcm80Settings(p);
  const a = PCM80_ALGORITHMS[s.algo];
  const v = p[id];
  switch (id) {
    case 'mix':
      return `MIX ${pct(v)}`;
    case 'input':
      return `IN ${fmtDb(v)}`;
    case 'output':
      return `OUT ${fmtDb(v)}`;
    case 'tempo':
    case 'div':
      return `${knobBpm(p['tempo'])}BPM ${pick(p['div'], NOTE_VALUES).name}`;
    case 'adjust':
      return s.kind === 'chords' ? `*CHORD ${pick(v, CHORDS).name}` : `*${a.adjust} ${pct(v)}`;
  }
  if (s.kind === 'chords') {
    const c = s.chords;
    if (id === 'decay') return `RES ${fmtTime(c.decay)}`;
    if (id === 'size') return `ROOT ${noteLabel(c.root)}`;
    if (id === 'tone') return `TONE ${fmtHz(c.toneHz)}`;
    if (id === 'depth') return `DTUN ${Math.round(c.detune)}C`;
    return `STRM ${fmtTime(c.strum)}`;
  }
  const r = s.kind === 'reverb' ? s.reverb : undefined;
  const t = s.kind === 'reverb' ? undefined : s.taps;
  switch (id) {
    case 'decay':
      if (r?.room.shape === 'inverse') return `LEN ${fmtTime(r.room.rt)}`;
      if (r) return `RT ${fmtTime(r.room.rt)}`;
      return `FBK ${pct(t!.feedback)}`;
    case 'size':
      if (r) return `SIZE ${Math.round(r.room.size)}M`;
      return s.algo >= 5 ? `SPRD ${pct(v)}` : `DLY ${fmtTime(t!.taps[0].time)}`;
    case 'tone':
      return `TONE ${fmtHz(r ? r.room.trebleHz : t!.toneHz)}`;
    case 'depth':
      return `DPTH ${pct(v)}`;
    default:
      return `RATE ${(r ? r.rate : t!.rate).toFixed(2)}`;
  }
}

const focus = focusTracker('adjust');

export const pcm80: GearDef = rack({
  kind: 'pcm80',
  label: 'PCM-80',
  subtitle: 'DIGITAL EFFECTS PROCESSOR',
  w: 17,
  h: 3,
  params: [
    p('input', 'INPUT', 0.7),
    sel(
      'algo',
      'ALGO',
      PCM80_ALGORITHMS.map((a) => a.name),
      0,
    ),
    p('adjust', 'ADJUST', 0.3),
    p('tempo', 'TEMPO', 0.4),
    sel(
      'div',
      'NOTE',
      NOTE_VALUES.map((n) => n.name),
      4,
    ),
    p('decay', 'DECAY', 0.5),
    p('size', 'SIZE', 0.5),
    p('tone', 'TONE', 0.6),
    p('depth', 'DEPTH', 0.3),
    p('rate', 'RATE', 0.35),
    p('mix', 'MIX', 0.4),
    p('output', 'OUTPUT', 0.7),
  ],
  sections: [
    { title: 'INPUT', rows: [['input']] },
    { title: 'PROGRAM', rows: [['algo'], ['adjust']] },
    { title: 'TEMPO', rows: [['tempo'], ['div']] },
    {
      title: 'EDIT',
      rows: [
        ['decay', 'size'],
        ['tone', null],
      ],
    },
    { title: 'LFO', rows: [['depth'], ['rate']] },
    { title: 'CONTROLS', rows: [['mix'], ['output']] },
  ],
  display: (params) => {
    const a = PCM80_ALGORITHMS[pcm80Algorithm(params)];
    const id = focus(params);
    return `${a.short}\n${pcm80Readout(params, id === 'algo' ? 'adjust' : id)}`;
  },
  face: { panel: '#2b2c30', text: '#e4e2dc', display: '#9fe8ff' },
});
