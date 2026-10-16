// CHORD-8: chord and progression generator, a note effect with no sound of its own. Keys (or a
// NOTE IN cable) come in, chords go out of NOTE OUT, through the player FX: strum, arpeggiator,
// rhythm patterns, a bouncing repeat and a per-note pitch slide. Everything here is pure (no
// Web Audio, no timers) so it runs under `node --test`; the timing lives in audio/chords-unit.ts.

import { type GearDef, type ParamDef, bi, p, rocker, sel } from './gear-types.ts';
import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Seven-note scales, as semitones above the key. */
export const SCALES: { label: string; steps: number[] }[] = [
  { label: 'MAJOR', steps: [0, 2, 4, 5, 7, 9, 11] },
  { label: 'MINOR', steps: [0, 2, 3, 5, 7, 8, 10] },
  { label: 'DORIAN', steps: [0, 2, 3, 5, 7, 9, 10] },
  { label: 'PHRYGIAN', steps: [0, 1, 3, 5, 7, 8, 10] },
  { label: 'LYDIAN', steps: [0, 2, 4, 6, 7, 9, 11] },
  { label: 'MIXOLYDIAN', steps: [0, 2, 4, 5, 7, 9, 10] },
  { label: 'HARM MINOR', steps: [0, 2, 3, 5, 7, 8, 11] },
  { label: 'MEL MINOR', steps: [0, 2, 3, 5, 7, 9, 11] },
];

export const MODES = ['PADS', 'SCALE'];
/** CHORD SIZE: AUTO takes each pad's own size (a triad when building on a key). */
export const SIZES = ['AUTO', 'TRIAD', '7TH', '9TH', '11TH'];
export const VOICINGS = ['CLOSE', 'OPEN', 'DROP 2', 'SPREAD'] as const;
export type Voicing = 'close' | 'open' | 'drop2' | 'spread';
const VOICING_IDS: Voicing[] = ['close', 'open', 'drop2', 'spread'];
export const STYLES = ['POP', 'JAZZ', 'BOSSA', 'MODAL', 'CINEMA'];
export const STRUM_DIRS = ['UP', 'DOWN', 'ALT'];
export const ARP_MODES = ['OFF', 'UP', 'DOWN', 'UP-DN', 'RANDOM', 'CHORD'];
export type ArpMode = 'off' | 'up' | 'down' | 'updown' | 'random' | 'chord';
const ARP_IDS: ArpMode[] = ['off', 'up', 'down', 'updown', 'random', 'chord'];
/** ARP RATE, as note values; `ARP_BEATS` is each one's length in quarter notes. */
export const ARP_RATES = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
const ARP_BEATS = [1, 1 / 2, 1 / 3, 1 / 4, 1 / 6, 1 / 8];
export const OCTAVES = ['-2', '-1', '0', '+1', '+2'];

// ── Patterns ─────────────────────────────────────────────

/** One bar of sixteenths: `x` an accented hit, `o` a hit, `.` a rest. */
export const PATTERN_PRESETS: { label: string; steps: string }[] = [
  { label: 'OFF', steps: '' },
  { label: '4THS', steps: 'x...o...x...o...' },
  { label: '8THS', steps: 'x.o.o.o.x.o.o.o.' },
  { label: 'OFFBEAT', steps: '..x...o...x...o.' },
  { label: 'CHARLSTN', steps: 'x.....o.x.....o.' },
  { label: 'BOSSA', steps: 'x..o..o...o..o..' },
  { label: 'SYNCO', steps: 'x..o..x.o.o..o.o' },
  { label: 'GEN', steps: '' },
];
/** PATTERN's last position plays the pattern rolled by the dice. */
export const GEN_PATTERN = PATTERN_PRESETS.length - 1;

/** A pattern string as 16 velocity scales (0 = rest). */
export function parsePattern(steps: string): number[] {
  return Array.from({ length: 16 }, (_, i) => ({ x: 1, o: 0.72 })[steps[i] as 'x' | 'o'] ?? 0);
}

/** Sixteenths until the next hit after step `i` (wrapping), for the gate. */
export function stepsToNext(pattern: number[], i: number): number {
  for (let d = 1; d <= pattern.length; d++) if (pattern[(i + d) % pattern.length] > 0) return d;
  return pattern.length;
}

// ── Seeded random ────────────────────────────────────────

/** mulberry32: a small, fast seeded generator, 0 ≤ x < 1. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks an index with probability proportional to its weight. */
export function weighted(weights: number[], r: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

// ── Scales and chords ────────────────────────────────────

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** The MIDI note of scale degree `degree` (any integer; 7 = an octave up) above `tonic`. */
export function degreeNote(tonic: number, scale: number[], degree: number): number {
  return tonic + 12 * Math.floor(degree / 7) + scale[mod(degree, 7)];
}

/**
 * Snaps a key to the scale: the nearest scale note (a tie goes down) and its degree, counted
 * from the tonic below `note` (0–6) plus whole octaves.
 */
export function snapToScale(note: number, key: number, scale: number[]) {
  let best = { note, degree: 0, dist: Infinity };
  const octave = Math.floor((note - key) / 12);
  for (let d = -7; d <= 14; d++) {
    const n = degreeNote(key + 12 * octave, scale, d);
    const dist = Math.abs(n - note) + (n > note ? 0.1 : 0);
    if (dist < best.dist) best = { note: n, degree: d + 7 * octave, dist };
  }
  return { note: best.note, degree: best.degree };
}

/** Notes in a chord of this size: triad 3, 7th 4, 9th 5, 11th 6. */
export const sizeNotes = (size: number) => size + 2;

/**
 * The diatonic chord on `degree`: stacked scale thirds above its root, root position, ascending.
 * `size` 1 = triad, 2 = 7th, 3 = 9th, 4 = 11th.
 */
export function diatonicChord(tonic: number, scale: number[], degree: number, size: number) {
  return Array.from({ length: sizeNotes(size) }, (_, i) =>
    degreeNote(tonic, scale, degree + 2 * i),
  );
}

/** Moves the lowest note up an octave, `n` times. */
export function invert(notes: number[], n: number): number[] {
  const out = [...notes].sort((a, b) => a - b);
  for (let i = 0; i < n; i++) out.push(out.shift()! + 12);
  return out;
}

/**
 * Spreads a close chord out. OPEN lifts every other note an octave; DROP 2 drops the second note
 * from the top an octave; SPREAD puts the root an octave below and opens the rest.
 */
export function voice(notes: number[], voicing: Voicing): number[] {
  const n = [...notes].sort((a, b) => a - b);
  if (n.length < 3) return n;
  switch (voicing) {
    case 'open':
      return n.map((x, i) => (i % 2 ? x + 12 : x)).sort((a, b) => a - b);
    case 'drop2':
      n[n.length - 2] -= 12;
      return n.sort((a, b) => a - b);
    case 'spread':
      return [n[0] - 12, ...voice(n.slice(1), 'open')];
    default:
      return n;
  }
}

/** How far a chord moves from `prev`: each note to its nearest note in the other, both ways. */
export function motion(a: number[], b: number[]): number {
  const near = (x: number, set: number[]) => Math.min(...set.map((y) => Math.abs(x - y)));
  return a.reduce((s, x) => s + near(x, b), 0) + b.reduce((s, x) => s + near(x, a), 0);
}

/**
 * Voice leading: of every inversion (and its octave neighbours), the one that moves least from
 * the previous chord, with a gentle pull toward `centre` so a long progression doesn't drift away.
 */
export function leadFrom(
  notes: number[],
  prev: number[] | null,
  voicing: Voicing,
  centre: number,
): number[] {
  if (!prev?.length) return voice(notes, voicing);
  let best: number[] = notes;
  let bestCost = Infinity;
  for (let inv = 0; inv < notes.length; inv++) {
    for (const shift of [-12, 0, 12]) {
      const cand = voice(
        invert(notes, inv).map((x) => x + shift),
        voicing,
      );
      const mean = cand.reduce((a, b) => a + b, 0) / cand.length;
      const cost = motion(cand, prev) + 0.5 * Math.abs(mean - centre);
      if (cost < bestCost) [best, bestCost] = [cand, cost];
    }
  }
  return best;
}

// ── Chord names ──────────────────────────────────────────

/**
 * Names a chord from its root and its stacked tones (root position, as `diatonicChord` builds
 * them): Cmaj7, Dm9, G7b9, Bm7b5, F#dim7, Cmaj7#11… `bass` adds a slash when it isn't the root.
 */
export function chordName(stack: number[], bass?: number): string {
  const root = stack[0];
  const [, third = 4, fifth = 7, seventh, ninth, eleventh] = stack.map((n) => mod(n - root, 12));
  const minor = third === 3;
  let q: string;
  if (minor && fifth === 6) q = seventh === undefined ? 'dim' : seventh === 9 ? 'dim7' : 'm7b5';
  else if (!minor && fifth === 8)
    q = seventh === undefined ? 'aug' : seventh === 11 ? 'maj7#5' : '7#5';
  else if (seventh === undefined) q = minor ? 'm' : '';
  else if (seventh === 11) q = minor ? 'mMaj7' : 'maj7';
  else q = minor ? 'm7' : '7';
  let ext = '';
  if (ninth !== undefined) {
    // A plain 7th chord takes its highest natural extension as its number (Dm7 → Dm9 → Dm11).
    const plain = q.endsWith('7') && q !== 'dim7';
    const head = eleventh === 5 ? '11' : ninth === 2 ? '9' : null;
    if (plain && head) q = q.slice(0, -1) + head;
    if (ninth !== 2) ext += ninth === 1 ? 'b9' : '#9';
    else if (!plain) ext += '(9)';
    if (eleventh !== undefined && !(plain && head === '11'))
      ext += eleventh === 6 ? '#11' : eleventh === 5 ? '(11)' : 'b11';
  }
  let name = NOTE_NAMES[mod(root, 12)] + q + ext;
  if (bass !== undefined && mod(bass, 12) !== mod(root, 12))
    name += '/' + NOTE_NAMES[mod(bass, 12)];
  return name;
}

/** Roman numeral of a degree in the scale (upper case for a major third, ° for diminished). */
export function roman(scale: number[], degree: number): string {
  const r = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][mod(degree, 7)];
  const st = diatonicChord(0, scale, mod(degree, 7), 1).map((n) => n - scale[mod(degree, 7)]);
  if (st[1] === 4) return r;
  return r.toLowerCase() + (st[2] === 6 ? '°' : '');
}

// ── Progressions ─────────────────────────────────────────

/** One pad: a scale degree (0–6) and its size (1 triad … 4 11th). */
export interface Pad {
  degree: number;
  size: number;
}

/** A progression is stored as text, `degree:size` per pad: "0:1 4:1 5:1 3:1 …". */
export const formatProgression = (pads: Pad[]) =>
  pads.map((d) => `${d.degree}:${d.size}`).join(' ');

export function parseProgression(text: string | undefined): Pad[] | null {
  const parts = text?.trim().split(/\s+/) ?? [];
  if (parts.length !== 8) return null;
  const pads = parts.map((s) => {
    const [d, z] = s.split(':').map(Number);
    return { degree: mod(Math.round(d), 7), size: Math.min(4, Math.max(1, Math.round(z))) };
  });
  return pads.some((d) => Number.isNaN(d.degree) || Number.isNaN(d.size)) ? null : pads;
}

/** Before the dice is rolled: I vi IV V, then ii7 V7 Imaj7 IVmaj7. */
export const DEFAULT_PROGRESSION: Pad[] = parseProgression('0:1 5:1 3:1 4:1 1:2 4:2 0:2 3:2')!;

interface Style {
  /** Where a progression starts, weighted by degree. */
  start: number[];
  /** Markov transitions: from each degree, weights to every degree. */
  next: number[][];
  /** Weights for triad, 7th, 9th, 11th. */
  sizes: number[];
  /** Weights for the rhythm the dice rolls for PATTERN GEN: hits on each sixteenth. */
  rhythm: number[];
  /** Odd pads (2, 4, 6, 8) resolve a two-chord cell in this style (ii→V, V→I). */
  cells?: boolean;
}

//                    I  ii iii IV  V  vi vii
const STYLE_DEFS: Style[] = [
  // POP: I, IV, V and vi turning around each other, mostly triads.
  {
    start: [6, 0, 0, 1, 0, 3, 0],
    next: [
      [0, 1, 1, 4, 4, 4, 0],
      [1, 0, 0, 2, 5, 1, 0],
      [0, 0, 0, 3, 1, 4, 0],
      [4, 1, 0, 0, 4, 2, 0],
      [4, 0, 0, 2, 0, 4, 0],
      [1, 2, 1, 5, 3, 0, 0],
      [3, 0, 1, 0, 0, 1, 0],
    ],
    sizes: [8, 2, 0, 0],
    rhythm: [5, 0, 2, 1, 4, 0, 3, 1, 5, 0, 2, 1, 4, 0, 3, 1],
  },
  // JAZZ: chains of ii–V–I, 7ths and 9ths.
  {
    start: [3, 4, 1, 1, 0, 2, 0],
    next: [
      [0, 3, 1, 2, 0, 4, 0],
      [0, 0, 0, 0, 9, 0, 1],
      [0, 0, 0, 0, 0, 7, 0],
      [1, 0, 2, 0, 1, 0, 4],
      [7, 0, 1, 0, 0, 2, 0],
      [0, 7, 0, 1, 1, 0, 0],
      [0, 0, 5, 0, 0, 2, 0],
    ],
    sizes: [0, 5, 4, 1],
    rhythm: [4, 0, 1, 2, 1, 0, 4, 1, 1, 0, 3, 2, 1, 0, 4, 1],
    cells: true,
  },
  // BOSSA: Imaj7 to ii9–V7 and back, IV and vi for colour; 9ths over a syncopated comp.
  {
    start: [6, 2, 0, 0, 0, 1, 0],
    next: [
      [0, 5, 0, 2, 0, 2, 0],
      [0, 0, 0, 0, 8, 0, 0],
      [0, 0, 0, 0, 0, 6, 0],
      [2, 1, 0, 0, 2, 0, 2],
      [6, 0, 1, 1, 0, 1, 0],
      [0, 6, 0, 1, 0, 0, 0],
      [0, 0, 4, 0, 0, 0, 0],
    ],
    sizes: [0, 3, 6, 1],
    rhythm: [6, 0, 0, 5, 0, 0, 5, 0, 1, 0, 5, 0, 0, 5, 0, 1],
    cells: true,
  },
  // MODAL: hovers on the tonic and its neighbours (the mode's colour chords), open 9ths.
  {
    start: [9, 0, 0, 0, 0, 0, 1],
    next: [
      [1, 4, 0, 3, 0, 0, 4],
      [5, 0, 1, 1, 0, 0, 1],
      [2, 1, 0, 1, 0, 0, 0],
      [5, 1, 0, 0, 0, 0, 2],
      [3, 0, 0, 1, 0, 0, 1],
      [2, 0, 0, 1, 0, 0, 2],
      [5, 1, 0, 2, 0, 0, 0],
    ],
    sizes: [3, 2, 4, 1],
    rhythm: [5, 0, 0, 2, 0, 0, 3, 0, 2, 0, 0, 3, 0, 2, 0, 0],
  },
  // CINEMA: slow tonic, VI, III, VII and iv moves (in a minor scale), big triads and 9ths.
  {
    start: [7, 0, 0, 0, 0, 3, 0],
    next: [
      [0, 0, 2, 3, 1, 5, 3],
      [0, 0, 1, 0, 3, 1, 0],
      [1, 0, 0, 2, 0, 3, 4],
      [3, 0, 1, 0, 1, 3, 2],
      [4, 0, 0, 0, 0, 3, 0],
      [2, 0, 4, 3, 1, 0, 3],
      [3, 0, 3, 1, 0, 2, 0],
    ],
    sizes: [5, 1, 3, 1],
    rhythm: [6, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 1, 0, 2, 0],
  },
];

/** Rolls eight pads in a style: a weighted Markov walk over the degrees, sizes by the style. */
export function generateProgression(style: number, r: () => number): Pad[] {
  const s = STYLE_DEFS[mod(style, STYLE_DEFS.length)];
  const pads: Pad[] = [];
  let degree = weighted(s.start, r);
  for (let i = 0; i < 8; i++) {
    if (i > 0) {
      // In two-chord cells, every second pad follows the strongest pull (ii→V, V→I) for sure.
      const row = s.next[degree];
      degree =
        s.cells && i % 2 === 1 && r() < 0.7 ? row.indexOf(Math.max(...row)) : weighted(row, r);
    }
    pads.push({ degree, size: weighted(s.sizes, r) + 1 });
  }
  // The last pad should lead back into the first, so the eight loop: if it can't, swap in the
  // chord that best joins pad 7 to pad 1.
  const [first, last] = [pads[0].degree, pads[7].degree];
  if (s.next[last][first] === 0) {
    const join = s.next.map(
      (row, d) => s.next[pads[6].degree][d] * row[first] + (row[first] ? 0.01 : 0),
    );
    pads[7].degree = join.indexOf(Math.max(...join));
  }
  return pads;
}

/** A bar of sixteenths for PATTERN GEN, from the style's rhythmic weights. Beat 1 always hits. */
export function generatePattern(style: number, r: () => number): string {
  const w = STYLE_DEFS[mod(style, STYLE_DEFS.length)].rhythm;
  const max = Math.max(...w);
  return w
    .map((x, i) => {
      if (i === 0) return 'x';
      if (r() >= x / (max + 1)) return '.';
      return x === max ? 'x' : 'o';
    })
    .join('');
}

// ── Player FX ────────────────────────────────────────────

/**
 * STRUM: when each note of a chord starts, in ms, by its position low to high. ALT strums up on
 * even hits and down on odd ones.
 */
export function strumOffsets(count: number, gapMs: number, dir: number, hit = 0): number[] {
  const down = dir === 1 || (dir === 2 && hit % 2 === 1);
  return Array.from({ length: count }, (_, i) => (down ? count - 1 - i : i) * gapMs);
}

/** ARP: the note order for one cycle (CHORD plays the whole chord on every step). */
export function arpOrder(notes: number[], mode: ArpMode, octaves: number): number[][] {
  const up = [...notes].sort((a, b) => a - b);
  const span: number[] = [];
  for (let o = 0; o < octaves; o++) span.push(...up.map((n) => n + 12 * o));
  switch (mode) {
    case 'down':
      return [...span].reverse().map((n) => [n]);
    case 'updown':
      return [...span, ...span.slice(1, -1).reverse()].map((n) => [n]);
    case 'chord':
      return Array.from({ length: octaves }, (_, o) => up.map((n) => n + 12 * o));
    default: // 'up' (and 'random', which picks from the span itself)
      return span.map((n) => [n]);
  }
}

/** ARP rate: one step's length in ms at `bpm`. */
export const arpStepMs = (rate: number, bpm: number) => (60000 / bpm) * ARP_BEATS[rate];

/** One sixteenth at `bpm`, in ms (PATTERN steps). */
export const sixteenthMs = (bpm: number) => 60000 / bpm / 4;

/**
 * BOUNCE: like a dropped ball, each repeat comes sooner and softer. Returns each repeat's start
 * (ms after the first hit) and its velocity scale; the gaps shrink by `ratio` until they get
 * too short to hear (12 ms).
 */
export function bounceTimes(repeats: number, firstGapMs: number, ratio = 0.7) {
  const out: { at: number; level: number }[] = [];
  let at = 0;
  let gap = firstGapMs;
  for (let k = 1; k <= repeats && gap >= 12; k++) {
    at += gap;
    out.push({ at, level: Math.pow(0.8, k) });
    gap *= ratio;
  }
  return out;
}

/** BEND: the slide's offset in semitones `t` ms after the note starts (eases out to 0). */
export function slideAt(t: number, from: number, timeMs: number): number {
  if (t >= timeMs || from === 0) return 0;
  const x = Math.max(0, t) / timeMs;
  return from * (1 - x) * (1 - x);
}

// ── Settings ─────────────────────────────────────────────

export function chordsSettings(p: Params) {
  const bend = (p['bend'] ?? 0.5) * 2 - 1;
  return {
    mode: stepIndex(p['mode'], MODES.length) === 1 ? ('scale' as const) : ('pads' as const),
    key: stepIndex(p['key'], 12),
    scale: SCALES[stepIndex(p['scale'], SCALES.length)].steps,
    /** 0 = AUTO (the pad's own size), else 1 triad … 4 11th. */
    size: stepIndex(p['size'], SIZES.length),
    voicing: VOICING_IDS[stepIndex(p['voicing'], VOICING_IDS.length)],
    inversion: stepIndex(p['inversion'], 4),
    lead: p['lead'] >= 0.5,
    octave: stepIndex(p['octave'], OCTAVES.length) - 2,
    style: stepIndex(p['style'], STYLES.length),
    velocity: p['velocity'],
    /** STRUM: gap between notes, 0–120 ms (squared so the low end is fine). */
    strum: p['strum'] * p['strum'] * 120,
    strumDir: stepIndex(p['strumDir'], STRUM_DIRS.length),
    arp: ARP_IDS[stepIndex(p['arp'], ARP_IDS.length)],
    arpRate: stepIndex(p['arpRate'], ARP_RATES.length),
    arpOctaves: stepIndex(p['arpOct'], 3) + 1,
    /** GATE: how much of a step (arp) or of the gap to the next hit (pattern) a note lasts. */
    gate: 0.05 + 0.95 * p['gate'],
    pattern: stepIndex(p['pattern'], PATTERN_PRESETS.length),
    /** BOUNCE: 0–12 repeats. */
    bounce: Math.round(p['bounce'] * 12),
    bounceGap: expMap(p['bounceTime'], 60, 800),
    /** BEND: each note slides in from ±12 semitones (centre = off). */
    bend: Math.abs(bend) < 0.02 ? 0 : Math.round(bend * 12 * 4) / 4,
    bendTime: expMap(p['bendTime'], 20, 2000),
  };
}

export type ChordsSettings = ReturnType<typeof chordsSettings>;

/** Middle of the pads' range: C3 (MIDI 48), moved by OCTAVE. */
export const PAD_TONIC = 48;

/** The pad a key plays in PADS mode: white keys from the base C, wrapping every 8; black keys none. */
export function padForStep(step: number): number | null {
  const pc = mod(step, 12);
  const white = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6][pc];
  if (white < 0) return null;
  return mod(white + 7 * Math.floor(step / 12), 8);
}

/**
 * The chord a pad (or a key in SCALE mode) plays, voiced and named. `root` is the degree's
 * note in SCALE mode (the snapped key); pads sit around C3 + KEY + OCTAVE.
 */
export function buildChord(
  s: ChordsSettings,
  degree: number,
  padSize: number,
  prev: number[] | null,
  root?: number,
) {
  const d = mod(degree, 7);
  const size = s.size || padSize;
  const tonic =
    root === undefined ? PAD_TONIC + s.key + 12 * s.octave : root - s.scale[d] + 12 * s.octave;
  const stack = diatonicChord(tonic, s.scale, d, size);
  // Voice leading keeps pads within about an octave above the tonic, keys around their root.
  const centre = root === undefined ? tonic + 9 : stack[0] + 5;
  const notes = s.lead
    ? leadFrom(stack, prev, s.voicing, centre)
    : voice(invert(stack, s.inversion % stack.length), s.voicing);
  return { notes, name: chordName(stack, Math.min(...notes)) };
}

// ── Catalog ──────────────────────────────────────────────

const action = (id: string, label: string): ParamDef => ({ ...p(id, label, 0), action: id });

export const CHORDS_GEAR: GearDef = {
  kind: 'chords',
  label: 'CHORD-8',
  category: 'midi',
  w: 14,
  h: 7,
  jacks: [
    { id: 'notesIn', dir: 'in', signal: 'note', fx: 0.03, fy: 0.97, label: 'NOTE IN' },
    { id: 'notesOut', dir: 'out', signal: 'note', fx: 0.97, fy: 0.97, label: 'NOTE OUT' },
  ],
  params: [
    sel('mode', 'MODE', MODES, 0),
    sel('key', 'KEY', NOTE_NAMES, 0),
    sel(
      'scale',
      'SCALE',
      SCALES.map((s) => s.label),
      0,
    ),
    sel('size', 'CHORD SIZE', SIZES, 0),
    sel('voicing', 'VOICING', [...VOICINGS], 0),
    sel('inversion', 'INVERSION', ['ROOT', '1ST', '2ND', '3RD'], 0),
    rocker('lead', 'VOICE LEADING', 'orange', true),
    sel('octave', 'OCTAVE', OCTAVES, 2),
    sel('style', 'STYLE', STYLES, 0),
    action('dice', 'DICE'),
    action('rec', 'REC'),
    p('velocity', 'VELOCITY', 0.8),
    p('strum', 'STRUM', 0),
    sel('strumDir', 'STRUM DIR', STRUM_DIRS, 0),
    sel('arp', 'ARP', ARP_MODES, 0),
    sel('arpRate', 'ARP RATE', ARP_RATES, 3),
    sel('arpOct', 'ARP OCT', ['1', '2', '3'], 0),
    p('gate', 'GATE', 0.6),
    sel(
      'pattern',
      'PATTERN',
      PATTERN_PRESETS.map((d) => d.label),
      0,
    ),
    p('bounce', 'BOUNCE', 0),
    p('bounceTime', 'BOUNCE TIME', 0.6),
    bi('bend', 'BEND'),
    p('bendTime', 'BEND TIME', 0.45),
  ],
};

// ── Status line ──────────────────────────────────────────

/**
 * What the unit reports to its panel (via `Unit.status`): the chord sounding (or the last one),
 * the pads lit, and the next pad REC writes to (-1 when not recording). Tab-separated.
 */
export interface ChordsStatus {
  chord: string;
  lit: number[];
  rec: number;
}

export const formatStatus = (st: ChordsStatus) => `${st.chord}\t${st.lit.join(',')}\t${st.rec}`;

export function parseStatus(text: string | undefined): ChordsStatus {
  const [chord = '', lit = '', rec = '-1'] = (text ?? '').split('\t');
  return {
    chord,
    lit: lit ? lit.split(',').map(Number) : [],
    rec: Number(rec),
  };
}
