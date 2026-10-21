// TR-606 maths and pattern logic. The voices are analog, made from scratch per hit: the bass drum,
// snare and toms from damped oscillators (the snare with noise), the hi-hats and cymbal from six
// square-wave oscillators mixed into a metallic tone. The sequencer holds 32 patterns of up to
// 16 steps, each step a set of instruments plus one shared accent.

import { type GearDef, noteJacks, p, sel } from './gear-types.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** Steps a pattern, locations per group, groups (I / II). */
export const STEPS = 16;
export const LOCATIONS = 16;
export const GROUPS = 2;
export const PATTERNS = LOCATIONS * GROUPS;

/** The seven instruments, then the accent row, in the order the instrument selector turns. */
export const INSTRUMENTS = ['BD', 'SD', 'LT', 'HT', 'CY', 'OH', 'CH', 'AC'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export const INSTRUMENT_NAMES: Record<Instrument, string> = {
  BD: 'BASS DRUM',
  SD: 'SNARE DRUM',
  LT: 'LOW TOM',
  HT: 'HIGH TOM',
  CY: 'CYMBAL',
  OH: 'OPEN HI-HAT',
  CH: 'CLOSED HI-HAT',
  AC: 'ACCENT',
};
export const bit = (inst: Instrument) => 1 << INSTRUMENTS.indexOf(inst);
export const ACCENT_BIT = bit('AC');
/** The seven sounds (no accent). */
export const SOUNDS = INSTRUMENTS.slice(0, 7) as Exclude<Instrument, 'AC'>[];
export type Sound = (typeof SOUNDS)[number];

/** The four scales: steps a beat (16ths, 32nds, 8th-note triplets, 16th-note triplets). */
export const SCALES = [4, 8, 3, 6];
export const SCALE_NAMES = ['1/16', '1/32', '1/8 T', '1/16 T'];

/** Tempo range: the same as the TB-303's (♩ = 40 to 300). */
export const clampTempo = (bpm: number) => Math.min(300, Math.max(40, bpm));
export const stepSeconds = (bpm: number, scale: number) =>
  60 / clampTempo(bpm) / SCALES[Math.min(SCALES.length - 1, Math.max(0, scale))];

// ── Keys and NOTE cables ────────────────────────────────

/** The notes the instruments send from NOTE OUT: the white keys C–B from C2. */
export const SOUND_NOTES: Record<Sound, number> = {
  BD: 36,
  SD: 38,
  LT: 40,
  HT: 41,
  CY: 43,
  OH: 45,
  CH: 47,
};

/**
 * The instrument a played note triggers, by its name in any octave: the white keys C–B play
 * BD, SD, LT, HT, CY, OH, CH (as the instruments are printed left to right); the black keys
 * sit where a general MIDI drum map has them (C♯ crash, D♯ clap → snare, F♯ / G♯ closed hat,
 * A♯ open hat).
 */
const BY_PITCH: (Sound | null)[] = [
  'BD',
  'CY',
  'SD',
  'SD',
  'LT',
  'HT',
  'CH',
  'CY',
  'CH',
  'OH',
  'OH',
  'CH',
];
export const soundForNote = (note: number): Sound | null => BY_PITCH[((note % 12) + 12) % 12];

/** A note played this hard or harder is accented (the 606 itself has two levels: on and accent). */
export const ACCENT_VELOCITY = 0.9;

// ── Sound ───────────────────────────────────────────────

/** Each voice's tuning and decay (time constants, s). */
export const VOICE = {
  /** Two damped oscillators, the second an octave-and-a-bit up, plus a click. */
  bd: { freqs: [52, 86], taus: [0.085, 0.03], drop: 0.12 },
  sd: { freqs: [232, 410], taus: [0.035, 0.022], noiseTau: 0.07, hp: 1200 },
  lt: { freq: 128, tau: 0.13, drop: 0.06 },
  ht: { freq: 184, tau: 0.11, drop: 0.06 },
  /** The six square waves of the metal source (Hz). */
  metal: [205.3, 304.4, 369.6, 522.7, 540, 800],
  ch: { bp: 7600, hp: 6000, tau: 0.018 },
  oh: { bp: 7600, hp: 6000 },
  cy: { bp: 4400, hp: 3000, tau: 0.42 },
};

/**
 * The open hi-hat's decay follows the tempo knob, a known quirk of the hardware: here faster
 * tempos close it sooner and slower ones let it ring.
 */
export const openHatTau = (bpm: number) =>
  Math.min(0.4, Math.max(0.06, 0.16 * (120 / clampTempo(bpm))));

export function tr606Settings(p: Params) {
  const lvl = (v: number) => v * v * 1.6;
  return {
    /** Accent adds up to +6 dB to whatever plays on an accented step. */
    accent: 1 + p['accent'],
    levels: {
      BD: lvl(p['bd']),
      SD: lvl(p['sd']),
      LT: lvl(p['tom']),
      HT: lvl(p['tom']),
      CY: lvl(p['cy']),
      OH: lvl(p['hh']),
      CH: lvl(p['hh']),
    } satisfies Record<Sound, number>,
    volume: p['volume'] * p['volume'],
    group: stepIndex(p['group'], GROUPS),
  };
}

export type Tr606Settings = ReturnType<typeof tr606Settings>;

// ── Patterns ────────────────────────────────────────────

export interface Pattern {
  /** Last step played (1–16). */
  length: number;
  /** Index into SCALES. */
  scale: number;
  /** One bit per instrument (INSTRUMENTS order), accent the top bit. */
  steps: number[];
}

export const emptyPattern = (): Pattern => ({
  length: STEPS,
  scale: 0,
  steps: Array<number>(STEPS).fill(0),
});

/** Group I, pattern 1 comes with a beat on it, so RUN makes a sound straight away. */
export function demoPattern(): Pattern {
  const rows: Partial<Record<Instrument, string>> = {
    BD: 'x.....x.x.....x.',
    SD: '....x.......x...',
    CH: 'x.x.x.x.x.x.x...',
    OH: '..............x.',
    LT: '...............x',
    AC: 'x...x...x...x...',
  };
  const steps = Array<number>(STEPS).fill(0);
  for (const [inst, row] of Object.entries(rows))
    for (let i = 0; i < STEPS; i++) if (row[i] === 'x') steps[i] |= bit(inst as Instrument);
  return { length: STEPS, scale: 0, steps };
}

/** Patch text key of a pattern (0–31: group I is 0–15, group II 16–31). */
export const patternKey = (i: number) => `pattern${i + 1}`;
export const patternIndex = (group: number, location: number) => group * LOCATIONS + location;

/** A pattern as text: length, scale, then two hex digits a step. */
export function encodePattern(pattern: Pattern): string {
  const steps = pattern.steps.map((s) => (s & 0xff).toString(16).padStart(2, '0')).join('');
  return `${pattern.length}:${pattern.scale}:${steps}`;
}

export function decodePattern(text: string | undefined, fallback: Pattern): Pattern {
  const m = /^(\d+):(\d):([0-9a-f]*)$/.exec(text ?? '');
  if (!m) return fallback;
  const steps = Array.from(
    { length: STEPS },
    (_, i) => parseInt(m[3].slice(i * 2, i * 2 + 2) || '0', 16) || 0,
  );
  return {
    length: Math.min(STEPS, Math.max(1, +m[1] || STEPS)),
    scale: Math.min(SCALES.length - 1, +m[2]),
    steps,
  };
}

export function patternsFromText(text: Record<string, string> | undefined): Pattern[] {
  return Array.from({ length: PATTERNS }, (_, i) =>
    decodePattern(text?.[patternKey(i)], i === 0 ? demoPattern() : emptyPattern()),
  );
}

/** Flips one instrument on one step. */
export function toggleStep(pattern: Pattern, step: number, inst: Instrument): Pattern {
  return { ...pattern, steps: pattern.steps.map((s, i) => (i === step ? s ^ bit(inst) : s)) };
}

/** Sets one instrument on one step (TAP writes, never erases). */
export function setStep(pattern: Pattern, step: number, inst: Instrument): Pattern {
  return { ...pattern, steps: pattern.steps.map((s, i) => (i === step ? s | bit(inst) : s)) };
}

/** What a step plays: its sounds, and whether it is accented. */
export function stepHits(bits: number): { sounds: Sound[]; accent: boolean } {
  return { sounds: SOUNDS.filter((s) => bits & bit(s)), accent: (bits & ACCENT_BIT) !== 0 };
}

// ── Chains ──────────────────────────────────────────────

/**
 * The locations that play one after another (patch text "chain", e.g. "0,1,2"). Chained
 * locations all lie in one block of four (1–4, 5–8, 9–12, 13–16), as on the hardware.
 */
export function parseChain(text: string | undefined): number[] {
  const list = (text ?? '')
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < LOCATIONS);
  if (!list.length) return [0];
  const block = Math.floor(list[0] / 4);
  return [...new Set(list.filter((n) => Math.floor(n / 4) === block))].sort((a, b) => a - b);
}

export const encodeChain = (chain: number[]) => chain.join(',');

/**
 * Pressing a location: on its own it becomes the whole chain; with `add` it joins the chain if
 * it is in the same block of four (and leaves it if it was already there, unless it's the last).
 */
export function pressLocation(chain: number[], location: number, add: boolean): number[] {
  if (!add || Math.floor(location / 4) !== Math.floor(chain[0] / 4)) return [location];
  if (chain.includes(location))
    return chain.length > 1 ? chain.filter((n) => n !== location) : chain;
  return [...chain, location].sort((a, b) => a - b);
}

/** Live state for the panel: running, the step playing (−1 stopped), and the pattern playing. */
export const encodeStatus = (running: boolean, step: number, pattern: number) =>
  `${running ? 1 : 0}|${step}|${pattern}`;

export function parseStatus(text: string | undefined) {
  const [run, step, pat] = (text ?? '').split('|');
  return {
    running: run === '1',
    step: Number.isFinite(+step) && step !== undefined ? +step : -1,
    pattern: Number.isFinite(+pat) && pat !== undefined ? +pat : -1,
  };
}

// ── Catalog entry ───────────────────────────────────────

// TR-606 (1981): seven analog drum voices and a 32-pattern step sequencer clocked by the song
// tempo. The jacks sit along the back edge: NOTE IN / OUT where SYNC and the trigger outs are,
// then OUTPUT.
export const TR606_GEAR: GearDef = {
  kind: 'tr606',
  label: 'TR-606',
  category: 'synth',
  w: 12,
  h: 6,
  jacks: [
    ...noteJacks([0.6, 0.03], [0.67, 0.03]),
    { id: 'out', dir: 'out', fx: 0.965, fy: 0.03, label: 'OUTPUT' },
  ],
  params: [
    p('accent', 'ACCENT', 0.5),
    p('bd', 'BASS DRUM', 0.75),
    p('sd', 'SNARE DRUM', 0.7),
    p('tom', 'LOW TOM / HIGH TOM', 0.65),
    p('cy', 'CYMBAL', 0.6),
    p('hh', 'HI-HAT', 0.65),
    p('volume', 'VOLUME', 0.7),
    sel('group', 'PATTERN GROUP', ['I', 'II'], 0),
  ],
  // The panel is its own component (gear/tr606-panel).
};
