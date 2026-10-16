// CHOIR-16 maths: physically modelled singers. Nothing is sampled: each singer is a glottal
// source (a pulse shaped by tenseness, with breath, rasp and vibrato) driving a Kelly-Lochbaum
// tube model of the vocal tract with a nasal branch. This module holds everything the main
// thread needs and the reference versions of the DSP that public/worklets/choir.js mirrors
// (tests/choir.test.ts checks the two agree): the vowel chart, the tract area function, the
// glottal pulse, vowel motion, singer anatomy, styles and voice allocation. Interpretation
// notes in docs/devices/choir.md.

import { type GearDef, bi, p, sel } from './gear-types.ts';
import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** Most singers the processor holds. */
export const MAX_SINGERS = 16;
/** Speed of sound in the warm, humid tract, m/s. */
export const SOUND_SPEED = 350;

export type Mode = 'choir' | 'tutti' | 'solo';
export const MODES: Mode[] = ['choir', 'tutti', 'solo'];
export const MODE_LABELS = ['CHOIR', 'TUTTI', 'SOLO'];

export type SingerType = 'child' | 'woman' | 'man' | 'mixed';
export const SINGER_TYPES: SingerType[] = ['child', 'woman', 'man', 'mixed'];
export const TYPE_LABELS = ['CHILD', 'WOMAN', 'MAN', 'MIXED'];

export type Style = 'classical' | 'pop' | 'gospel' | 'folk' | 'rough';
export const STYLES: Style[] = ['classical', 'pop', 'gospel', 'folk', 'rough'];
export const STYLE_LABELS = ['CLASSICAL', 'POP', 'GOSPEL', 'FOLK', 'ROUGH'];

/** VOWEL MOTION: what moves the vowel while a note sings. */
export type Motion = 'off' | 'sine' | 'triangle' | 'steps' | 'envelope' | 'random';
export const MOTIONS: Motion[] = ['off', 'sine', 'triangle', 'steps', 'envelope', 'random'];
export const MOTION_LABELS = ['OFF', 'SINE', 'TRIANGLE', 'STEPS', 'ENVELOPE', 'RANDOM'];

export const CHOIR_GEAR: GearDef = {
  kind: 'choir',
  label: 'CHOIR-16',
  category: 'synth',
  w: 18,
  h: 9,
  jacks: [
    { id: 'notesIn', dir: 'in', signal: 'note', fx: 0.022, fy: 0.16, label: 'NOTE IN' },
    { id: 'out', dir: 'out', fx: 0.978, fy: 0.16 },
    { id: 'notesOut', dir: 'out', signal: 'note', fx: 0.978, fy: 0.3, label: 'NOTE OUT' },
  ],
  params: [
    sel('mode', 'MODE', MODE_LABELS, 0),
    sel(
      'singers',
      'SINGERS',
      Array.from({ length: MAX_SINGERS }, (_, i) => String(i + 1)),
      7,
    ),
    sel('style', 'STYLE', STYLE_LABELS, 0),
    p('legato', 'LEGATO', 0.3),
    sel('type', 'SINGER', TYPE_LABELS, 3),
    p('age', 'AGE', 0.3),
    bi('neck', 'NECK'),
    bi('jaw', 'JAW'),
    bi('lips', 'LIPS'),
    p('nose', 'NOSE', 0.15),
    p('vowelX', 'VOWEL X', 0.9),
    p('vowelY', 'VOWEL Y', 0.95),
    sel('motion', 'VOWEL MOTION', MOTION_LABELS, 0),
    p('motionRate', 'RATE', 0.45),
    p('motionDepth', 'DEPTH', 0.4),
    p('breath', 'BREATH', 0.5),
    p('rasp', 'RASP', 0.5),
    p('vibrato', 'VIBRATO', 0.5),
    p('attack', 'ATTACK', 0.35),
    p('release', 'RELEASE', 0.4),
    p('room', 'ROOM', 0.4),
    p('width', 'WIDTH', 0.6),
    p('volume', 'VOLUME', 0.7),
  ],
  // The panel is its own component (gear/choir-panel).
  keyboard: { from: -12, keys: 37 },
};

// ── Seeded randomness ─────────────────────────────────

/** A small seeded generator (mulberry32): a choir sounds the same every time it's loaded. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Vowels ────────────────────────────────────────────

/**
 * How the tract is shaped for a vowel. `tongue`: where along the tract the tongue body makes its
 * narrowing (0 = glottis, 1 = lips; front vowels near the palate, ɑ down in the pharynx);
 * `height`: how far it rises (0 = flat, 1 = close); `lips`: lip opening diameter in cm; `jaw`:
 * 0 closed – 1 open.
 */
export interface Articulation {
  tongue: number;
  height: number;
  lips: number;
  jaw: number;
}

export interface VowelAnchor extends Articulation {
  symbol: string;
  /** Position on the chart: x 0 = front … 1 = back, y 0 = close … 1 = open. */
  x: number;
  y: number;
}

/** The vowel chart's anchors, at their IPA chart positions (tuned against the model's formants). */
export const VOWELS: VowelAnchor[] = [
  { symbol: 'i', x: 0, y: 0, tongue: 0.7, height: 0.95, lips: 1.3, jaw: 0.2 },
  { symbol: 'y', x: 0.12, y: 0, tongue: 0.7, height: 0.9, lips: 0.55, jaw: 0.2 },
  { symbol: 'e', x: 0.1, y: 0.33, tongue: 0.66, height: 0.85, lips: 1.4, jaw: 0.35 },
  { symbol: 'ɛ', x: 0.2, y: 0.66, tongue: 0.62, height: 0.5, lips: 1.6, jaw: 0.6 },
  { symbol: 'a', x: 0.3, y: 1, tongue: 0.4, height: 0.35, lips: 1.9, jaw: 0.9 },
  { symbol: 'ɑ', x: 1, y: 1, tongue: 0.3, height: 0.75, lips: 1.8, jaw: 1 },
  { symbol: 'ɔ', x: 1, y: 0.66, tongue: 0.36, height: 0.7, lips: 1.0, jaw: 0.65 },
  { symbol: 'o', x: 1, y: 0.33, tongue: 0.46, height: 0.65, lips: 0.8, jaw: 0.4 },
  { symbol: 'u', x: 1, y: 0, tongue: 0.6, height: 0.85, lips: 0.45, jaw: 0.25 },
  { symbol: 'ə', x: 0.55, y: 0.5, tongue: 0.55, height: 0.05, lips: 1.2, jaw: 0.5 },
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The articulation at a point of the chart: inverse-distance weighting of the anchors (exact on
 * an anchor, smooth between them).
 */
export function vowelAt(x: number, y: number): Articulation {
  let wSum = 0;
  const out = { tongue: 0, height: 0, lips: 0, jaw: 0 };
  for (const v of VOWELS) {
    const d2 = (x - v.x) ** 2 + (y - v.y) ** 2;
    if (d2 < 1e-9) return { tongue: v.tongue, height: v.height, lips: v.lips, jaw: v.jaw };
    const w = 1 / (d2 * d2);
    wSum += w;
    out.tongue += w * v.tongue;
    out.height += w * v.height;
    out.lips += w * v.lips;
    out.jaw += w * v.jaw;
  }
  return {
    tongue: out.tongue / wSum,
    height: out.height / wSum,
    lips: out.lips / wSum,
    jaw: out.jaw / wSum,
  };
}

/** The anchor nearest a chart point (what the display names). */
export function nearestVowel(x: number, y: number): VowelAnchor {
  let best = VOWELS[0];
  let bd = Infinity;
  for (const v of VOWELS) {
    const d = (x - v.x) ** 2 + (y - v.y) ** 2;
    if (d < bd) [best, bd] = [v, d];
  }
  return best;
}

/** Grid points per side of the vowel table the worklet looks articulations up in. */
export const GRID = 17;

/**
 * The chart sampled on a GRID × GRID lattice, four numbers (tongue, height, lips, jaw) per point,
 * row by row from y = 0: sent to the worklet once, which interpolates it bilinearly.
 */
export function vowelGrid(size = GRID): Float32Array<ArrayBuffer> {
  const g = new Float32Array(size * size * 4);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const a = vowelAt(c / (size - 1), r / (size - 1));
      g.set([a.tongue, a.height, a.lips, a.jaw], (r * size + c) * 4);
    }
  return g;
}

/** Bilinear lookup in a `vowelGrid` (mirrored in the worklet as `gridLookup`). */
export function gridLookup(g: ArrayLike<number>, size: number, x: number, y: number): Articulation {
  const fx = clamp(x, 0, 1) * (size - 1);
  const fy = clamp(y, 0, 1) * (size - 1);
  const c0 = Math.min(size - 2, Math.floor(fx));
  const r0 = Math.min(size - 2, Math.floor(fy));
  const tx = fx - c0;
  const ty = fy - r0;
  const at = (r: number, c: number, k: number) => g[(r * size + c) * 4 + k];
  const v = (k: number) =>
    lerp(
      lerp(at(r0, c0, k), at(r0, c0 + 1, k), tx),
      lerp(at(r0 + 1, c0, k), at(r0 + 1, c0 + 1, k), tx),
      ty,
    );
  return { tongue: v(0), height: v(1), lips: v(2), jaw: v(3) };
}

// ── Vocal tract ───────────────────────────────────────

/** The singer's build as the tract model sees it (1 = average). */
export interface Shape {
  /** Oral cavity width (JAW). */
  jaw: number;
  /** Lip fullness: longer, slightly narrower lip section (LIPS). */
  lips: number;
  /** Pharynx width (a lowered larynx makes it wider and the voice darker). */
  pharynx: number;
}

export const NEUTRAL_SHAPE: Shape = { jaw: 1, lips: 1, pharynx: 1 };

/** Tract sections for a tract `lengthCm` long: one section per sample of travel at rate `fs`. */
export const tractSections = (lengthCm: number, fs: number) =>
  Math.max(8, Math.round(((lengthCm / 100) * fs) / SOUND_SPEED));

/** The nasal branch is about 60 % of the tract's length; it leaves the tract halfway up. */
export const noseSections = (n: number) => Math.max(4, Math.round(n * 0.6));
export const velumIndex = (n: number) => Math.round(n * 0.5);

/**
 * The tract's diameter profile in cm, glottis to lips, `n` sections (mirrored in the worklet as
 * `tractDiameters`). A narrow larynx, then a 1.5 cm tube that the tongue body bends: a cosine
 * bump centred on `tongue` narrows the tract there and widens it half a bump away (the tongue
 * keeps its volume, so a raised front pushes the root forward and opens the pharynx). The jaw
 * opens the front of the mouth; the last sections are the lips.
 */
export function tractDiameters(
  n: number,
  a: Articulation,
  shape: Shape = NEUTRAL_SHAPE,
  out: Float64Array = new Float64Array(n),
): Float64Array {
  const lipLen = 0.06 + 0.04 * (shape.lips - 1);
  const lipStart = 1 - lipLen;
  const lipD = a.lips * (1.08 - 0.08 * shape.lips);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    let d: number;
    if (x < 0.1) {
      d = 0.5 + 9 * x; // the larynx: 0.5 → 1.4 cm
    } else if (x < lipStart) {
      const phase = clamp((x - a.tongue) / 0.36, -1, 1);
      d = 1.5 - a.height * Math.cos(Math.PI * phase);
      // The jaw and mouth width open the front cavity.
      const front = clamp((x - 0.55) / 0.25, 0, 1);
      d *= lerp(1, (0.7 + 0.6 * a.jaw) * shape.jaw, front);
      // A wide pharynx (lowered larynx) at the back.
      const back = clamp((0.45 - x) / 0.3, 0, 1);
      d *= lerp(1, shape.pharynx, back);
      // Blend from the larynx into the pharynx.
      if (x < 0.16) d = lerp(1.4, d, (x - 0.1) / 0.06);
    } else {
      d = lipD;
    }
    out[i] = Math.max(0.05, d);
  }
  return out;
}

/** The nasal branch's diameters, velum to nostrils; section 0 is the velum opening. */
export function noseDiameters(m: number, velum: number, size = 1): Float64Array {
  const out = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const y = j / (m - 1);
    out[j] = size * (y < 0.4 ? 0.5 + 2 * y : 1.3 - 0.9 * (y - 0.4));
  }
  out[0] = velum;
  return out;
}

/** Pressure-wave reflection at the junction from area a1 into area a2. */
export const reflection = (a1: number, a2: number) => (a1 - a2) / (a1 + a2 || 1);

export const GLOTTAL_REFLECTION = 0.75;
export const LIP_REFLECTION = -0.85;
/** Per-sample wave loss in the tract (wall damping). */
export const TRACT_LOSS = 0.9985;

/**
 * A Kelly-Lochbaum tube driven at the glottis, for testing: returns the lip output for `input`.
 * One section of travel per sample; the worklet runs the same scattering (with the nasal branch).
 */
export function tractRun(diameters: ArrayLike<number>, input: ArrayLike<number>): Float64Array {
  const n = diameters.length;
  const k = new Float64Array(n);
  for (let i = 1; i < n; i++) k[i] = reflection(diameters[i - 1] ** 2, diameters[i] ** 2);
  let r = new Float64Array(n);
  let l = new Float64Array(n);
  let rn = new Float64Array(n);
  let ln = new Float64Array(n);
  const out = new Float64Array(input.length);
  for (let t = 0; t < input.length; t++) {
    rn[0] = (GLOTTAL_REFLECTION * l[0] + input[t]) * TRACT_LOSS;
    ln[n - 1] = LIP_REFLECTION * r[n - 1] * TRACT_LOSS;
    for (let i = 1; i < n; i++) {
      // Waves meeting at junction i: a from section i − 1, b from section i.
      const w = k[i] * (r[i - 1] - l[i]);
      rn[i] = (r[i - 1] + w) * TRACT_LOSS;
      ln[i - 1] = (l[i] + w) * TRACT_LOSS;
    }
    out[t] = r[n - 1] * (1 + LIP_REFLECTION);
    [r, rn] = [rn, r];
    [l, ln] = [ln, l];
  }
  return out;
}

/** Magnitude response (dB) of an impulse response at frequency f. */
export function responseDb(h: ArrayLike<number>, f: number, fs: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * f) / fs;
  for (let t = 0; t < h.length; t++) {
    re += h[t] * Math.cos(w * t);
    im -= h[t] * Math.sin(w * t);
  }
  return 10 * Math.log10(re * re + im * im + 1e-30);
}

/** The first resonance peaks of a tract (Hz), found on a 10 Hz grid up to `maxF`. */
export function formants(diameters: ArrayLike<number>, fs: number, count = 3, maxF = 4500) {
  const imp = new Float64Array(4096);
  imp[0] = 1;
  const h = tractRun(diameters, imp);
  const db: number[] = [];
  for (let f = 0; f <= maxF; f += 10) db.push(responseDb(h, f, fs));
  const peaks: number[] = [];
  for (let i = 1; i < db.length - 1 && peaks.length < count; i++)
    if (db[i] > db[i - 1] && db[i] >= db[i + 1]) peaks.push(i * 10);
  return peaks;
}

// ── Glottal source ────────────────────────────────────

/**
 * The glottal flow derivative over one period (`phase` 0–1), after Rosenberg's trigonometric
 * pulse: the folds open over the first `skew` of the open phase, close over the rest, and stay
 * shut for the last 1 − `oq` of the cycle. The sharp negative step at closure is what excites the
 * tract. Scaled so the closing peak is about −1 for a typical voice (mirrored in the worklet).
 */
export function glottalPulse(phase: number, oq: number, skew: number): number {
  const tp = oq * skew;
  if (phase < tp) return 0.075 * (Math.PI / tp) * Math.sin((Math.PI * phase) / tp);
  if (phase < oq) {
    const tc = oq - tp;
    return -0.15 * (Math.PI / 2 / tc) * Math.sin(((Math.PI / 2) * (phase - tp)) / tc);
  }
  return 0;
}

/** The glottal flow itself (0–1) at `phase`: how open the folds are (aspiration follows it). */
export function glottalFlow(phase: number, oq: number, skew: number): number {
  const tp = oq * skew;
  if (phase < tp) return 0.5 * (1 - Math.cos((Math.PI * phase) / tp));
  if (phase < oq) return Math.cos(((Math.PI / 2) * (phase - tp)) / (oq - tp));
  return 0;
}

/** Tenseness 0 (lax, breathy) – 1 (pressed) → open quotient and opening skew. */
export const glottalShape = (tense: number) => ({
  oq: 0.82 - 0.42 * clamp(tense, 0, 1),
  skew: 0.6 + 0.2 * clamp(tense, 0, 1),
});

// ── Vowel motion ──────────────────────────────────────

/** STEPS walks through these vowels (offsets toward them from the set vowel). */
export const STEP_VOWELS = ['a', 'e', 'i', 'o', 'u'].map((s) =>
  VOWELS.find((v) => v.symbol === s)!,
);

/**
 * How far VOWEL MOTION moves the vowel from its knob position, as a chart offset (mirrored in the
 * worklet as `vowelMotion`). `phase` is the LFO's cycles so far, `t` the seconds since the note
 * began, `tau` the envelope's time, `rx` / `ry` the note's random draw (−1…1), and `base` the
 * set vowel (STEPS heads from it toward each step vowel).
 */
export function vowelMotion(
  mode: number,
  phase: number,
  depth: number,
  t: number,
  tau: number,
  rx: number,
  ry: number,
  bx: number,
  by: number,
): [number, number] {
  const w = phase - Math.floor(phase);
  switch (mode) {
    case 1: // SINE: an ellipse around the set vowel
      return [0.4 * depth * Math.cos(2 * Math.PI * w), 0.5 * depth * Math.sin(2 * Math.PI * w)];
    case 2: {
      // TRIANGLE: the same path at a constant speed, with corners
      const tri = (u: number) => 1 - 4 * Math.abs(u - Math.floor(u + 0.5));
      return [0.4 * depth * tri(w + 0.25), 0.5 * depth * tri(w)];
    }
    case 3: {
      const v = STEP_VOWELS[Math.floor(phase) % STEP_VOWELS.length];
      return [(v.x - bx) * depth, (v.y - by) * depth];
    }
    case 4: {
      // ENVELOPE: the note opens from a closer, rounder vowel into the set one
      const e = Math.exp(-t / Math.max(0.01, tau));
      return [0.3 * depth * e, -0.9 * depth * e];
    }
    case 5: // RANDOM: a fresh vowel each note
      return [rx * depth, ry * depth];
    default:
      return [0, 0];
  }
}

// ── Styles ────────────────────────────────────────────

/** How a style uses the voice. Depths in semitones, times in seconds. */
export interface StyleDef {
  tense: number;
  breath: number;
  rasp: number;
  vibDepth: number;
  vibRate: number;
  vibDelay: number;
  /** Notes start this far below pitch and slide up. */
  scoop: number;
  scoopTime: number;
  /** Slow pitch wander, in semitones. */
  drift: number;
  /** Tract length factor: a lowered larynx (classical) is longer and darker. */
  larynx: number;
  /** Pharynx width factor. */
  pharynx: number;
}

export const STYLE_DEFS: Record<Style, StyleDef> = {
  // Tense, ringing, dark (lowered larynx, wide throat); strong vibrato after a moment.
  classical: {
    tense: 0.72,
    breath: 0.08,
    rasp: 0,
    vibDepth: 0.55,
    vibRate: 5.6,
    vibDelay: 0.3,
    scoop: 0.15,
    scoopTime: 0.06,
    drift: 0.05,
    larynx: 1.06,
    pharynx: 1.15,
  },
  // Breathy and light, bright (higher larynx); a little late vibrato.
  pop: {
    tense: 0.4,
    breath: 0.45,
    rasp: 0.05,
    vibDepth: 0.15,
    vibRate: 5.2,
    vibDelay: 0.45,
    scoop: 0.35,
    scoopTime: 0.08,
    drift: 0.08,
    larynx: 0.97,
    pharynx: 0.95,
  },
  // Full and gritty, notes scooped up from below.
  gospel: {
    tense: 0.65,
    breath: 0.2,
    rasp: 0.3,
    vibDepth: 0.35,
    vibRate: 5.9,
    vibDelay: 0.25,
    scoop: 1.6,
    scoopTime: 0.12,
    drift: 0.07,
    larynx: 1,
    pharynx: 1.05,
  },
  // Plain, straight tone, almost no vibrato.
  folk: {
    tense: 0.5,
    breath: 0.18,
    rasp: 0.04,
    vibDepth: 0.05,
    vibRate: 5,
    vibDelay: 0.8,
    scoop: 0.15,
    scoopTime: 0.05,
    drift: 0.06,
    larynx: 1,
    pharynx: 1,
  },
  // A rough, strained storyteller's voice: heavy rasp and pressure, slow wide vibrato.
  rough: {
    tense: 0.92,
    breath: 0.3,
    rasp: 0.75,
    vibDepth: 0.5,
    vibRate: 4.6,
    vibDelay: 0.2,
    scoop: 0.9,
    scoopTime: 0.1,
    drift: 0.12,
    larynx: 1.03,
    pharynx: 0.9,
  },
};

// ── Settings ──────────────────────────────────────────

/** BREATH, RASP, VIBRATO: 0.5 is the style as it is, 0 none, 1 double. */
const amount = (v: number) => v * 2;

export function choirSettings(p: Params) {
  const style = STYLES[stepIndex(p['style'] ?? 0, STYLES.length)];
  const st = STYLE_DEFS[style];
  const rasp = p['rasp'] ?? 0.5;
  return {
    mode: MODES[stepIndex(p['mode'] ?? 0, MODES.length)],
    singers: stepIndex(p['singers'] ?? 7 / 15, MAX_SINGERS) + 1,
    style,
    /** LEGATO: glide time between tied notes in SOLO / TUTTI (0 = every note restarts). */
    legato: (p['legato'] ?? 0) < 0.02 ? 0 : expMap(p['legato'], 0.02, 1),
    type: SINGER_TYPES[stepIndex(p['type'] ?? 1, SINGER_TYPES.length)],
    age: p['age'] ?? 0.3,
    /** NECK: tract length ±12 %. */
    neck: 1 + ((p['neck'] ?? 0.5) * 2 - 1) * 0.12,
    jaw: 1 + ((p['jaw'] ?? 0.5) * 2 - 1) * 0.2,
    lips: 1 + ((p['lips'] ?? 0.5) * 2 - 1) * 0.6,
    /** NOSE: velum opening (nasality), cm. */
    velum: (p['nose'] ?? 0) * 0.5,
    noseSize: 0.8 + 0.4 * (p['nose'] ?? 0),
    vowelX: p['vowelX'] ?? 0.5,
    vowelY: p['vowelY'] ?? 0.5,
    motion: MOTIONS[stepIndex(p['motion'] ?? 0, MOTIONS.length)],
    motionRate: expMap(p['motionRate'] ?? 0.5, 0.05, 8),
    motionDepth: p['motionDepth'] ?? 0,
    tense: st.tense,
    breath: clamp(
      st.breath * amount(p['breath'] ?? 0.5) + Math.max(0, (p['breath'] ?? 0.5) - 0.5) * 0.3,
      0,
      1,
    ),
    rasp: clamp(st.rasp * amount(rasp) + Math.max(0, rasp - 0.5) * 0.8, 0, 1),
    vibDepth: st.vibDepth * amount(p['vibrato'] ?? 0.5),
    vibRate: st.vibRate,
    vibDelay: st.vibDelay,
    scoop: st.scoop,
    scoopTime: st.scoopTime,
    drift: st.drift,
    larynx: st.larynx,
    pharynx: st.pharynx,
    attack: expMap(p['attack'] ?? 0.35, 0.008, 2),
    release: expMap(p['release'] ?? 0.4, 0.03, 4),
    room: p['room'] ?? 0.4,
    width: p['width'] ?? 0.6,
    volume: (p['volume'] ?? 0.7) ** 2,
  };
}

export type ChoirSettings = ReturnType<typeof choirSettings>;

// ── Singers ───────────────────────────────────────────

/** One singer's body and habits, fixed per seat in the choir (seeded, so it doesn't change). */
export interface Singer {
  type: 'child' | 'woman' | 'man';
  /** Vocal tract length, cm. */
  length: number;
  shape: Shape;
  /** Middle of the comfortable range, MIDI note. */
  centre: number;
  /** Stage position −1 (left) … 1 (right), before WIDTH. */
  pan: number;
  /** Small fixed detune, semitones: no two singers are exactly in tune. */
  detune: number;
  vibRate: number;
  vibDepth: number;
  breath: number;
  jitter: number;
  tense: number;
  /** Seconds this singer lags the others coming in. */
  lag: number;
  seed: number;
}

const TYPE_BODY = {
  // tract length young → old (cm), range centre young → old (MIDI)
  child: { length: [10.5, 12.5], centre: [72, 69] },
  woman: { length: [14.4, 15.0], centre: [66, 62] },
  man: { length: [16.8, 17.6], centre: [52, 55] },
};

/** The `count` singers on stage: their bodies from the SINGER controls plus each one's own quirks. */
export function singers(s: ChoirSettings, count = MAX_SINGERS): Singer[] {
  return Array.from({ length: count }, (_, i) => {
    const rnd = seeded(0x51ce + i * 7919);
    const v = () => rnd() * 2 - 1;
    const type = s.type === 'mixed' ? (i % 2 ? 'man' : 'woman') : s.type;
    const b = TYPE_BODY[type];
    // Children don't age past childhood: AGE moves them from small to older child.
    const old = type === 'child' ? 0 : s.age;
    // Registers within a section: soprano / alto, tenor / bass… spread around the centre.
    const register = [0, -5, 4, -2, 2, -6, 5, -3][i % 8];
    return {
      type,
      length: lerp(b.length[0], b.length[1], s.age) * s.neck * s.larynx * (1 + 0.03 * v()),
      shape: {
        jaw: s.jaw * (1 + 0.07 * v()),
        lips: s.lips * (1 + 0.1 * v()),
        pharynx: s.pharynx * (1 + 0.05 * v()),
      },
      centre: lerp(b.centre[0], b.centre[1], s.age) + register,
      pan: stagePan(i, count) + 0.06 * v(),
      detune: 0.06 * v(),
      vibRate: (1 - 0.15 * old) * (1 + 0.07 * v()),
      vibDepth: (type === 'child' ? 0.6 : 1 + 0.6 * old) * (1 + 0.15 * v()),
      breath: (type === 'child' ? 1.25 : 1 + 0.8 * old) * (1 + 0.2 * v()),
      jitter: 1 + 1.5 * old + 0.3 * v(),
      tense: 0.05 * v() + (type === 'man' ? 0.03 : 0),
      lag: 0.012 + 0.012 * v(),
      seed: (i + 1) * 0x9e3779b1,
    };
  });
}

/** Where seat `i` of `count` stands, −1…1: spread evenly across the stage. */
export const stagePan = (i: number, count: number) => (count < 2 ? 0 : (i / (count - 1)) * 2 - 1);

/**
 * TUTTI: the octave each singer takes for `note`, cycling unison / below / above so one key
 * sings across octaves, then moved by octaves into the singer's range (±14 semitones of centre).
 */
export function tuttiOffset(i: number, note: number, centre: number): number {
  let o = [0, -12, 12][i % 3];
  while (note + o - centre > 14) o -= 12;
  while (centre - (note + o) > 14) o += 12;
  return o;
}

// ── Voice allocation ──────────────────────────────────

/** What the allocator tells a singer to do. */
export interface Assignment {
  singer: number;
  note: number;
  /** The voice (a NOTE cable's `voice`, or the keyboard's) driving the singer. */
  voice: number;
  /** Glide from the previous note instead of starting afresh (SOLO / TUTTI legato). */
  legato: boolean;
}

/**
 * Hands notes to singers. CHOIR: each note goes to the next free singer (the one whose range fits
 * best, then round robin; the longest-sounding is taken when all are busy). TUTTI: the newest
 * held note sings in every singer, each in their own octave. SOLO: the newest held note sings in
 * the first singer. In TUTTI and SOLO letting go of the newest note returns to the one before.
 */
export class Allocator {
  /** The voice each singer sings, or null when free. */
  readonly owner: (number | null)[] = Array(MAX_SINGERS).fill(null);
  private readonly since: number[] = Array(MAX_SINGERS).fill(0);
  private clock = 0;
  private cursor = 0;
  /** Held notes in SOLO / TUTTI, oldest first. */
  private held: { voice: number; note: number }[] = [];

  on(voice: number, note: number, mode: Mode, cast: Singer[], glide: boolean): Assignment[] {
    const count = cast.length;
    if (mode !== 'choir') {
      const tied = glide && this.held.length > 0;
      this.held = this.held.filter((h) => h.voice !== voice);
      this.held.push({ voice, note });
      return this.mono(voice, note, mode, cast, tied);
    }
    this.held = [];
    let pick = -1;
    let best = Infinity;
    for (let k = 0; k < count; k++) {
      const s = (this.cursor + k) % count;
      if (this.owner[s] !== null) continue;
      // Out-of-range singers only when nobody suits better; otherwise round robin.
      const score = Math.max(0, Math.abs(note - cast[s].centre) - 10) + k * 0.01;
      if (score < best) [pick, best] = [s, score];
    }
    if (pick < 0) {
      // Everybody's singing: take the one who started longest ago.
      pick = 0;
      for (let s = 1; s < count; s++) if (this.since[s] < this.since[pick]) pick = s;
    }
    this.cursor = (pick + 1) % count;
    this.owner[pick] = voice;
    this.since[pick] = ++this.clock;
    return [{ singer: pick, note, voice, legato: false }];
  }

  /** A voice let go: the singers to release, or (SOLO / TUTTI) to glide back to the note before. */
  off(
    voice: number,
    mode: Mode,
    cast: Singer[],
    glide: boolean,
  ): { release: number[]; back: Assignment[] } {
    if (mode !== 'choir' && this.held.length) {
      const top = this.held[this.held.length - 1];
      this.held = this.held.filter((h) => h.voice !== voice);
      if (top.voice !== voice) return { release: [], back: [] };
      const prev = this.held[this.held.length - 1];
      if (prev) return { release: [], back: this.mono(prev.voice, prev.note, mode, cast, glide) };
    }
    const release: number[] = [];
    this.owner.forEach((o, s) => {
      if (o === voice) {
        release.push(s);
        this.owner[s] = null;
      }
    });
    return { release, back: [] };
  }

  /** The singers a voice is driving right now (for 'expr'). */
  singersOf(voice: number): number[] {
    const out: number[] = [];
    this.owner.forEach((o, s) => o === voice && out.push(s));
    return out;
  }

  reset() {
    this.owner.fill(null);
    this.held = [];
  }

  private mono(
    voice: number,
    note: number,
    mode: Mode,
    cast: Singer[],
    legato: boolean,
  ): Assignment[] {
    const seats = mode === 'solo' ? [0] : cast.map((_, i) => i);
    this.owner.fill(null);
    return seats.map((s) => {
      this.owner[s] = voice;
      this.since[s] = ++this.clock;
      const o = mode === 'tutti' ? tuttiOffset(s, note, cast[s].centre) : 0;
      return { singer: s, note: note + o, voice, legato };
    });
  }
}

// ── Live state for the panel ──────────────────────────

export interface ChoirStatus {
  /** Bit per singer: sounding. */
  mask: number;
  /** The vowel the most recent singer is on right now. */
  x: number;
  y: number;
  /** How hard it's singing, 0–1 (opens the face's mouth). */
  level: number;
}

/** The unit's status line: "mask x y level" (see `parseChoirStatus`). */
export const choirStatus = (s: ChoirStatus) =>
  `${s.mask} ${s.x.toFixed(3)} ${s.y.toFixed(3)} ${s.level.toFixed(2)}`;

export function parseChoirStatus(text: string | undefined): ChoirStatus | null {
  if (!text) return null;
  const [mask, x, y, level] = text.split(' ').map(Number);
  if ([mask, x, y, level].some((v) => !Number.isFinite(v))) return null;
  return { mask, x, y, level };
}
