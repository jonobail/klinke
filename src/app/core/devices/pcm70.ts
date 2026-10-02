// PCM-70 digital effects processor, after the service packet (070-04337 owner's manual companion):
// §2.1 "more than 40 digital effects and reverb programs, including Chorus and Echo, Resonant
// Chords, Multiband Delays, Rich Chamber, Rich Plate, and Concert Hall"; §2.1.1 (fig. 2.1) the
// front panel — headroom LEDs, INPUT level, a 10-digit display, the SOFT KNOB that edits the
// selected parameter, program rows / columns (e.g. program 0.3); fig. 2.2 one MAIN INPUT and
// LEFT / RIGHT outputs; §2.2 processed signal 20 Hz–15 kHz; §4.1.3 33.85 kHz sampling; §4.1.4 the
// master processor MUTEs the converters on every program change. Program numbers and names of the
// delay / chorus programs are from field bulletin 070-04662 (software 1.2), which also gives the
// DIFFUSION parameter of the Chorus and Echo and Multiband Delay families (adds 4–20 ms).
//
// Each program is one of seven algorithms (see docs/devices/pcm70.md); the knobs are the main
// parameters of the program's matrix, and SOFT is the parameter the program patches to the soft knob.

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
  type Topology,
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

export type Pcm70Family = 'chorusEcho' | 'multiband' | 'chords' | RoomShape;

interface DelayProgram {
  /** Delay range of the DELAY knob in seconds, or `bpm` for the tempo programs. */
  range?: [number, number];
  bpm?: boolean;
  /** Each tap: time multiple (of DELAY, or of the note value), pan, LFO phase. */
  taps: [number, number, number][];
  topology: Topology;
  /** Feedback sign: the stereo flange runs negative feedback. */
  invert?: boolean;
  /** Most the DECAY knob can feed back, and most the DEPTH knob can sweep (s). */
  maxFeedback: number;
  maxDepth: number;
}

export interface Pcm70Program {
  num: string;
  name: string;
  /** What fits on the 10-digit display beside the number. */
  short: string;
  family: Pcm70Family;
  delay?: DelayProgram;
}

const ce = (d: DelayProgram) => d;

/** The programs, in panel order (row.column). */
export const PCM70_PROGRAMS: Pcm70Program[] = [
  {
    num: '0.0',
    name: 'CHORUS',
    short: 'CHORUS',
    family: 'chorusEcho',
    delay: ce({
      range: [0.005, 0.04],
      taps: [
        [1, -1, 0],
        [1.3, 1, 0.5],
        [1.6, 0, 0.25],
      ],
      topology: 'self',
      maxFeedback: 0.6,
      maxDepth: 0.006,
    }),
  },
  {
    num: '0.3',
    name: 'STEREO FLANGE',
    short: 'FLANGE',
    family: 'chorusEcho',
    delay: ce({
      range: [0.0006, 0.012],
      taps: [
        [1, -1, 0],
        [1, 1, 0.25],
      ],
      topology: 'self',
      invert: true,
      maxFeedback: 0.92,
      maxDepth: 0.004,
    }),
  },
  {
    num: '0.7',
    name: 'PSYCHO ECHOES',
    short: 'PSYCHO',
    family: 'chorusEcho',
    delay: ce({
      range: [0.06, 0.8],
      taps: [
        [1, -1, 0],
        [1.37, 0.6, 0.3],
        [1.93, -0.4, 0.6],
        [2.71, 1, 0.9],
      ],
      topology: 'self',
      maxFeedback: 0.8,
      maxDepth: 0.004,
    }),
  },
  {
    num: '0.8',
    name: 'ECHOES BPM',
    short: 'ECHO BPM',
    family: 'chorusEcho',
    delay: ce({
      bpm: true,
      taps: [
        [1, -0.7, 0],
        [1.5, 0.7, 0.5],
      ],
      topology: 'self',
      maxFeedback: 0.9,
      maxDepth: 0.0015,
    }),
  },
  {
    num: '0.9',
    name: 'CHORUS AND ECHO BPM',
    short: 'C&E BPM',
    family: 'chorusEcho',
    delay: ce({
      bpm: true,
      taps: [
        [1, -1, 0],
        [1, 1, 0.5],
        [2, 0, 0.25],
      ],
      topology: 'self',
      maxFeedback: 0.85,
      maxDepth: 0.006,
    }),
  },
  {
    num: '1.1',
    name: 'DOUBLE DELAY',
    short: 'DBL DLY',
    family: 'multiband',
    delay: ce({
      range: [0.02, 1.2],
      taps: [
        [1, -1, 0],
        [2, 1, 0.5],
      ],
      topology: 'self',
      maxFeedback: 0.9,
      maxDepth: 0.002,
    }),
  },
  {
    num: '1.3',
    name: 'CIRCULAR DELAYS',
    short: 'CIRCULAR',
    family: 'multiband',
    delay: ce({
      range: [0.04, 0.8],
      taps: [
        [1, -1, 0],
        [1.25, -0.33, 0.25],
        [1.5, 0.33, 0.5],
        [1.75, 1, 0.75],
      ],
      topology: 'ring',
      maxFeedback: 0.95,
      maxDepth: 0.002,
    }),
  },
  {
    num: '1.8',
    name: 'BOUNCING BPM',
    short: 'BOUNCE',
    family: 'multiband',
    delay: ce({
      bpm: true,
      taps: [
        [1, -1, 0],
        [1, 1, 0.5],
      ],
      topology: 'ring',
      maxFeedback: 0.92,
      maxDepth: 0.001,
    }),
  },
  { num: '2.0', name: 'RESONANT CHORDS', short: 'RESCHORD', family: 'chords' },
  { num: '3.0', name: 'CONCERT HALL', short: 'CONCERT', family: 'hall' },
  { num: '4.0', name: 'RICH CHAMBER', short: 'CHAMBER', family: 'chamber' },
  { num: '5.0', name: 'RICH PLATE', short: 'PLATE', family: 'plate' },
  {
    num: '6.1',
    name: 'CASCADE BPM',
    short: 'CASCADE',
    family: 'multiband',
    delay: ce({
      bpm: true,
      taps: [
        [1, -1, 0],
        [1, -0.33, 0.25],
        [1, 0.33, 0.5],
        [1, 1, 0.75],
      ],
      topology: 'cascade',
      maxFeedback: 0.9,
      maxDepth: 0.001,
    }),
  },
  { num: '7.0', name: 'INVERSE ROOM', short: 'INVERSE', family: 'inverse' },
];

const DEFAULT_PROGRAM = 9; // 3.0 CONCERT HALL

const isRoom = (f: Pcm70Family): f is RoomShape =>
  f === 'hall' || f === 'chamber' || f === 'plate' || f === 'inverse';

/** Multiband taps each sit in their own band, low to high across the stereo field. */
export const bandHz = (i: number, n: number) => (n < 2 ? 1200 : 300 * Math.pow(16, i / (n - 1)));

export type Pcm70Settings =
  | { program: Pcm70Program; kind: 'reverb'; reverb: ReverbSettings }
  | { program: Pcm70Program; kind: 'taps'; taps: TapSettings; bpm?: number; note?: string }
  | { program: Pcm70Program; kind: 'chords'; chords: ChordSettings };

export const pcm70Program = (p: Params) => PCM70_PROGRAMS[Math.round(p['program'] * 13)];

export function pcm70Settings(p: Params): Pcm70Settings {
  const program = pcm70Program(p);
  const f = program.family;
  const toneHz = expMap(p['treble'], 1000, 15000);
  if (isRoom(f)) {
    const inverse = f === 'inverse';
    return {
      program,
      kind: 'reverb',
      reverb: {
        room: {
          shape: f,
          rt: inverse
            ? expMap(p['decay'], 0.12, 1)
            : expMap(p['decay'], 0.3, f === 'hall' ? 20 : 8),
          bassMult: 0.5 + 2 * p['soft'],
          trebleHz: toneHz,
          size: expMap(p['size'], 4, 40),
          slope: 6 + 30 * p['soft'],
        },
        predelay: 0.5 * p['delay'] * p['delay'],
        depth: 0.002 * p['depth'],
        rate: expMap(p['rate'], 0.05, 4),
      },
    };
  }
  if (f === 'chords') {
    return {
      program,
      kind: 'chords',
      chords: {
        root: 24 + Math.round(p['delay'] * 36),
        steps: pick(p['soft'], CHORDS).steps,
        decay: expMap(p['decay'], 0.2, 8),
        toneHz: expMap(p['treble'], 800, 12000),
        detune: 25 * p['depth'],
        width: p['size'],
        strum: 0.08 * p['rate'],
      },
    };
  }
  const d = program.delay!;
  const bpm = d.bpm ? knobBpm(p['delay']) : undefined;
  const note = d.bpm ? pick(p['size'], NOTE_VALUES) : undefined;
  const base = note ? beatSeconds(bpm!, note.beats) : expMap(p['delay'], ...d.range!);
  const times = d.taps.map(([m]) => (note ? base * m : base * (1 + p['size'] * (m - 1))));
  const depth = Math.min(d.maxDepth * p['depth'], 0.8 * Math.min(...times));
  return {
    program,
    kind: 'taps',
    bpm,
    note: note?.name,
    taps: {
      taps: d.taps.map(([, pan, phase], i) => ({
        time: times[i],
        pan,
        phase,
        band: f === 'multiband' ? bandHz(i, d.taps.length) : 0,
        send: d.topology === 'self' || i === 0 ? 1 : 0,
      })),
      topology: d.topology,
      feedback: (d.invert ? -1 : 1) * d.maxFeedback * p['decay'],
      toneHz,
      depth,
      rate: expMap(p['rate'], 0.05, 8),
      diffusion: p['soft'],
    },
  };
}

/** The second display line: the control being changed, in the program's own terms. */
export function pcm70Readout(p: Params, id: string): string {
  const s = pcm70Settings(p);
  const v = p[id];
  if (id === 'mix') return `MIX ${pct(v)}`;
  if (id === 'input') return `IN ${fmtDb(v)}`;
  if (id === 'output') return `OUT ${fmtDb(v)}`;
  if (s.kind === 'reverb') {
    const r = s.reverb;
    const inv = r.room.shape === 'inverse';
    switch (id) {
      case 'decay':
        return inv ? `LEN ${fmtTime(r.room.rt)}` : `RT ${fmtTime(r.room.rt)}`;
      case 'delay':
        return `PRE ${fmtTime(r.predelay)}`;
      case 'size':
        return `SIZE ${Math.round(r.room.size)}M`;
      case 'treble':
        return `TREB ${fmtHz(r.room.trebleHz)}`;
      case 'depth':
        return `SPIN ${pct(v)}`;
      case 'rate':
        return `RATE ${r.rate.toFixed(2)}`;
      default:
        return inv ? `SLOPE ${Math.round(r.room.slope!)}DB` : `BASS ${r.room.bassMult.toFixed(1)}X`;
    }
  }
  if (s.kind === 'chords') {
    const c = s.chords;
    switch (id) {
      case 'decay':
        return `RES ${fmtTime(c.decay)}`;
      case 'delay':
        return `ROOT ${noteLabel(c.root)}`;
      case 'size':
        return `WIDE ${pct(v)}`;
      case 'treble':
        return `TONE ${fmtHz(c.toneHz)}`;
      case 'depth':
        return `DTUN ${Math.round(c.detune)}C`;
      case 'rate':
        return `STRM ${fmtTime(c.strum)}`;
      default:
        return `CHRD ${pick(p['soft'], CHORDS).name}`;
    }
  }
  const t = s.taps;
  switch (id) {
    case 'decay':
      return `FBK ${Math.round(t.feedback * 100)}%`;
    case 'delay':
      return s.bpm ? `${s.bpm} BPM` : `DLY ${fmtTime(t.taps[0].time)}`;
    case 'size':
      return s.note ? `NOTE ${s.note}` : `SPRD ${pct(v)}`;
    case 'treble':
      return `TREB ${fmtHz(t.toneHz)}`;
    case 'depth':
      return `DPTH ${fmtTime(t.depth)}`;
    case 'rate':
      return `RATE ${t.rate.toFixed(2)}`;
    default:
      return `DIFF ${pct(v)}`;
  }
}

const focus = focusTracker('soft');

export const pcm70: GearDef = rack({
  kind: 'pcm70',
  label: 'PCM-70',
  subtitle: 'DIGITAL EFFECTS PROCESSOR',
  w: 16,
  h: 3,
  params: [
    p('input', 'INPUT', 0.7),
    sel(
      'program',
      'PROGRAM',
      PCM70_PROGRAMS.map((x) => `${x.num} ${x.name}`),
      DEFAULT_PROGRAM,
    ),
    p('soft', 'SOFT', 0.4),
    p('decay', 'DECAY', 0.5),
    p('delay', 'DELAY', 0.3),
    p('size', 'SIZE', 0.5),
    p('treble', 'TREBLE', 0.6),
    p('depth', 'DEPTH', 0.3),
    p('rate', 'RATE', 0.35),
    p('mix', 'MIX', 0.4),
    p('output', 'OUTPUT', 0.7),
  ],
  sections: [
    { title: 'INPUT', rows: [['input']] },
    { title: 'PROGRAM', rows: [['program'], ['soft']] },
    {
      title: 'PARAMETERS',
      rows: [
        ['decay', 'delay'],
        ['size', 'treble'],
      ],
    },
    { title: 'MOD', rows: [['depth'], ['rate']] },
    { title: 'OUTPUT', rows: [['mix'], ['output']] },
  ],
  display: (params) => {
    const prog = pcm70Program(params);
    const id = focus(params);
    // After a program change, show what the soft knob now does.
    return `${prog.num} ${prog.short}\n${pcm70Readout(params, id === 'program' ? 'soft' : id)}`;
  },
  face: { panel: '#2a2b2e', text: '#d8d6cf', display: '#7df9e3' },
});
