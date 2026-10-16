// TB-303 maths, after the service notes (Feb. 1982; 3rd printing Sep. 1986): specifications p.1,
// block diagram p.3, main board circuit p.5 (VCO, VCF, ENV, VCA, slide, accent), adjustment
// pp.6–7 (CV, VCO and VCF trims) and "VCF envelope modulation" p.8.

import { type GearDef, bi, noteJacks, p, sel } from './gear-types.ts';
import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** Steps in a pattern (spec: 1 to 16 steps per measure) and patterns kept here. */
export const STEPS = 16;
export const PATTERNS = 8;

/**
 * The low C key with neither DOWN nor UP: 2 V on the CV (p.5: the A key is 2.75 V = 110 Hz at
 * 1 V/oct; p.6–7: DOWN's low C is 1 V and UP's high C 4 V, the pattern's 3 octaves), i.e. C2.
 */
export const BASE_NOTE = 36;

/** CUT OFF FREQ range (Hz). Centre ≈ 500 Hz, where the filter rings at 2 ms with RES full (p.7). */
const CUTOFF_MIN = 70;
const CUTOFF_MAX = 3500;

/** DECAY: the time to fall to 10 % (p.5: VR MAX 2.5 s, MIN 200 ms). */
export const DECAY_MIN = 0.2;
export const DECAY_MAX = 2.5;

/** SLIDE: C35 (0.22 µF) charged through the 100 kΩ leg into the CV buffer (p.5): τ = 22 ms. */
export const SLIDE_TAU = 0.022;
/** ACCENT sweep: the accent voltage charges C13 (1 µF) through R46 (47 kΩ) (p.5): τ = 47 ms. */
export const SWEEP_TAU = 0.047;

/** Tempo control range (spec: ♩ = 40 to 300). */
export const clampTempo = (bpm: number) => Math.min(300, Math.max(40, bpm));
/** One step is a sixteenth note (spec: minimum step ♩ = 4 sixteenths). */
export const stepSeconds = (bpm: number) => 60 / clampTempo(bpm) / 4;

export type Wave = 'saw' | 'square';
const WAVES: Wave[] = ['saw', 'square'];

/**
 * ENV MOD (p.8, "VCF envelope modulation"): turning it up deepens the envelope *and* lowers the
 * starting cutoff (Q9 biases Q10 / Q11), so the sweep stays in the range where it is heard.
 * Both in cents of cutoff.
 */
export function envModCutoff(envMod: number) {
  return { depth: envMod * 4800, shift: -envMod * 1500 };
}

/** A decay time to 10 % → the time constant of an exponential fall. */
export const decayTau = (toTenPercent: number) => toTenPercent / Math.LN10;

export function tb303Settings(p: Params) {
  const env = envModCutoff(p['envMod']);
  return {
    tuneCents: (p['tuning'] * 2 - 1) * 700, // approx. ±700 cents, a perfect fifth (spec)
    wave: WAVES[stepIndex(p['wave'], 2)],
    cutoff: expMap(p['cutoff'], CUTOFF_MIN, CUTOFF_MAX),
    /** RESONANCE: a peak on the ladder that rings but barely oscillates; Web Audio Q is in dB. */
    resonance: Math.pow(p['resonance'], 1.5) * 24,
    envDepth: env.depth,
    envShift: env.shift,
    decay: expMap(p['decay'], DECAY_MIN, DECAY_MAX),
    accent: p['accent'],
    /**
     * Accent sweep depth (cents). RESONANCE is a dual pot (VR4, p.5): its second gang feeds the
     * accent sweep, so more resonance means a bigger accent "wow".
     */
    sweep: p['accent'] * (0.35 + 0.65 * p['resonance']) * 2400,
    volume: p['volume'] * p['volume'],
    pattern: stepIndex(p['pattern'], PATTERNS),
  };
}

export type Tb303Settings = ReturnType<typeof tb303Settings>;

// ── Patterns ────────────────────────────────────────────

/** TIME MODE: each step is a NOTE, a TIE (holds the note before) or a REST. */
export type Time = 'note' | 'tie' | 'rest';

/** PITCH MODE: a key C–C' (0–12), DOWN / UP (−1 / +1 octave), ACCENT, SLIDE. */
export interface Step {
  pitch: number;
  oct: number;
  accent: boolean;
  slide: boolean;
  time: Time;
}

export interface Pattern {
  /** Last step played (1–16), set with LAST STEP. */
  length: number;
  steps: Step[];
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', "C'"];

export const clearStep = (): Step => ({
  pitch: 0,
  oct: 0,
  accent: false,
  slide: false,
  time: 'note',
});

/** A cleared pattern: 16 low Cs. */
export const emptyPattern = (): Pattern => ({
  length: STEPS,
  steps: Array.from({ length: STEPS }, clearStep),
});

const s = (pitch: number, time: Time = 'note', oct = 0, accent = false, slide = false): Step => ({
  pitch,
  oct,
  accent,
  slide,
  time,
});

/** Pattern 1 comes with a line on it, so RUN makes a sound straight away. */
export function demoPattern(): Pattern {
  return {
    length: 16,
    steps: [
      s(0, 'note', 0, true),
      s(0, 'note', 1),
      s(3, 'note', 0, false, true),
      s(0, 'note', 1),
      s(0, 'rest'),
      s(0, 'note', 0, true),
      s(7, 'note', 0, false, true),
      s(10, 'note'),
      s(10, 'tie'),
      s(0, 'note', 1, true, true),
      s(3, 'note', 0),
      s(0, 'rest'),
      s(5, 'note', 0, true),
      s(0, 'note', -1, false, true),
      s(0, 'note', 0),
      s(7, 'note', 0, true),
    ],
  };
}

/** The patch text key a pattern is stored under ('pattern1' … 'pattern8'). */
export const patternKey = (i: number) => `pattern${i + 1}`;

const PITCH_CHARS = '0123456789abc';
const OCT_CHARS = 'd-u'; // DOWN, neither, UP
const FLAG_CHARS = '.asb'; // none, accent, slide, both
const TIME_CHARS: Record<Time, string> = { note: 'n', tie: 't', rest: 'r' };

/**
 * A pattern as a short line of text (patch text values are kept short): the length, then four
 * characters a step: pitch (0–c), octave (d - u), accent / slide (. a s b), time (n t r).
 */
export function encodePattern(pattern: Pattern): string {
  const steps = pattern.steps.map(
    (st) =>
      PITCH_CHARS[st.pitch] +
      OCT_CHARS[st.oct + 1] +
      FLAG_CHARS[(st.accent ? 1 : 0) + (st.slide ? 2 : 0)] +
      TIME_CHARS[st.time],
  );
  return `${pattern.length}:${steps.join('')}`;
}

const charIndex = (chars: string, c: string | undefined, def: number) => {
  const i = c ? chars.indexOf(c) : -1;
  return i < 0 ? def : i;
};

/** Reads a stored pattern; a missing or unreadable one comes back as `fallback`. */
export function decodePattern(text: string | undefined, fallback: Pattern): Pattern {
  const m = /^(\d+):([0-9a-z.\-]*)$/.exec(text ?? '');
  if (!m) return fallback;
  const body = m[2];
  const steps = Array.from({ length: STEPS }, (_, i): Step => {
    const [p, o, f, t] = body.slice(i * 4, i * 4 + 4);
    const flags = charIndex(FLAG_CHARS, f, 0);
    return {
      pitch: charIndex(PITCH_CHARS, p, 0),
      oct: charIndex(OCT_CHARS, o, 1) - 1,
      accent: (flags & 1) !== 0,
      slide: (flags & 2) !== 0,
      time: t === 'r' ? 'rest' : t === 't' ? 'tie' : 'note',
    };
  });
  return { length: Math.min(STEPS, Math.max(1, +m[1] || STEPS)), steps };
}

/** All the patterns from the gear's text (pattern 1 defaults to the demo line). */
export function patternsFromText(text: Record<string, string> | undefined): Pattern[] {
  return Array.from({ length: PATTERNS }, (_, i) =>
    decodePattern(text?.[patternKey(i)], i === 0 ? demoPattern() : emptyPattern()),
  );
}

/** The note a step plays. */
export const stepNote = (step: Pick<Step, 'pitch' | 'oct'>) =>
  BASE_NOTE + step.oct * 12 + step.pitch;

export const stepName = (step: Step) =>
  `${NOTE_NAMES[step.pitch]}${step.oct < 0 ? '↓' : step.oct > 0 ? '↑' : ''}`;

/**
 * A played note → the key and DOWN / UP that write it in PITCH MODE. Notes outside the three
 * octaves fold to their pitch class at the nearest end.
 */
export function pitchFromNote(note: number): { pitch: number; oct: number } {
  const rel = note - BASE_NOTE;
  if (rel < -12) return { pitch: ((rel % 12) + 12) % 12, oct: -1 };
  if (rel > 24) return { pitch: ((rel % 12) + 12) % 12, oct: 1 };
  if (rel < 0) return { pitch: rel + 12, oct: -1 };
  if (rel > 12) return { pitch: rel - 12, oct: 1 };
  return { pitch: rel, oct: 0 };
}

/** What the sequencer does on one step. */
export interface StepPlay {
  kind: Time;
  note: number;
  accent: boolean;
  /** Slid into from the step before: the pitch glides and the envelopes don't retrigger. */
  legato: boolean;
  /** The gate stays open past this step (a TIE follows, or SLIDE into the next NOTE). */
  hold: boolean;
}

/**
 * Resolves a pattern into what each step plays, looping at its length. A TIE carries the note
 * (and its slide) of the NOTE before it; a TIE after a REST is a rest. SLIDE on a note holds the
 * gate into the next NOTE, which glides to its pitch without a new attack, as on the hardware.
 */
export function resolvePattern(pattern: Pattern): StepPlay[] {
  const n = Math.min(STEPS, Math.max(1, pattern.length));
  const steps = pattern.steps.slice(0, n);
  /** The NOTE a step sounds (itself, or the one a TIE holds), or null for silence. */
  const source = (i: number): Step | null => {
    for (let k = 0; k < n; k++) {
      const st = steps[(i - k + n) % n];
      if (st.time === 'note') return st;
      if (st.time === 'rest') return null;
    }
    return null; // all ties: nothing to hold
  };
  const plays = steps.map((st, i): StepPlay => {
    const src = source(i);
    const next = steps[(i + 1) % n];
    const kind: Time = src ? st.time : 'rest';
    return {
      kind,
      note: src ? stepNote(src) : BASE_NOTE,
      accent: !!src && src.accent && kind === 'note',
      legato: false,
      hold: !!src && (next.time === 'tie' || (src.slide && next.time === 'note')),
    };
  });
  for (let i = 0; i < n; i++) {
    const prev = plays[(i - 1 + n) % n];
    if (plays[i].kind === 'note' && prev.kind !== 'rest' && prev.hold) plays[i].legato = true;
  }
  return plays;
}

/** Live state for the panel: running, and the step playing (−1 when stopped). */
export const encodeStatus = (running: boolean, step: number) => `${running ? 1 : 0}|${step}`;

export function parseStatus(text: string | undefined): { running: boolean; step: number } {
  if (!text) return { running: false, step: -1 };
  const [run, step] = text.split('|');
  return { running: run === '1', step: Number.isFinite(+step) ? +step : -1 };
}

// ── Catalog entry ───────────────────────────────────────

// TB-303 (1981): one VCO (saw / square) → 4-pole ladder VCF → VCA, a decay-only envelope, accent
// and slide, and a 16-step pattern sequencer clocked by the song tempo. The jacks sit along the
// back edge as on the hardware: NOTE IN / OUT where CV / GATE are, then OUTPUT.
export const TB303_GEAR: GearDef = {
  kind: 'tb303',
  label: 'TB-303',
  category: 'synth',
  w: 12,
  h: 7,
  jacks: [
    ...noteJacks([0.6, 0.03], [0.67, 0.03]),
    { id: 'out', dir: 'out', fx: 0.965, fy: 0.03, label: 'OUTPUT' },
  ],
  params: [
    sel('wave', 'WAVEFORM', ['SAW', 'SQUARE'], 0),
    bi('tuning', 'TUNING'),
    p('cutoff', 'CUT OFF FREQ', 0.35),
    p('resonance', 'RESONANCE', 0.65),
    p('envMod', 'ENV MOD', 0.55),
    p('decay', 'DECAY', 0.35),
    p('accent', 'ACCENT', 0.6),
    p('volume', 'VOLUME', 0.7),
    sel('pattern', 'PATTERN', ['1', '2', '3', '4', '5', '6', '7', '8'], 0),
  ],
  // The panel is its own component (gear/tb303-panel), laid out like the silver original.
};
