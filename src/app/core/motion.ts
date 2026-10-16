// MOTION-15: a note effect with no sound of its own. Plain notes in, per-voice expression out
// (MPE-style: every voice its own bend, pressure and timbre on the NOTE cable). When the chord
// changes, the voices already sounding glide to the new notes instead of restarting; held voices
// swell, wander, drift and pick up vibrato; the autopilot keeps them moving by itself.
//
// Everything here is pure (tested in `tests/motion.test.ts`); `audio/motion-unit.ts` runs it at
// control rate.

import { type GearDef, type ParamDef, bi, p, rocker, sel } from './gear-types.ts';

/** Most voices the pool hands out (one MPE zone's worth of member channels). */
export const MAX_VOICES = 15;
/** Per-note bend range, semitones either way: further than this a voice retriggers. */
export const BEND_RANGE = 48;
/** Notes arriving within this many ms are one chord. */
export const CHORD_WINDOW_MS = 30;
export const PATTERN_STEPS = 8;
/** Autopilot pattern steps run −7…+7. */
export const STEP_MAX = 7;

export const LEADING = ['SMART', 'CLASSIC'] as const;
export const GLIDE_MODES = ['TIME', 'RATE'] as const;
export const CURVES = ['LINEAR', 'EASE IN', 'EASE OUT', 'S-CURVE', 'OVERSHOOT'] as const;
export const STAGGERS = [
  'NONE',
  'LOW→HIGH',
  'HIGH→LOW',
  'OUTSIDE IN',
  'INSIDE OUT',
  'RANDOM',
] as const;
export const PATHS = ['DIRECT', 'ARC UP', 'ARC DOWN', 'ZIGZAG', 'SWIRL'] as const;
export const STARTS = ['NONE', 'BELOW', 'ABOVE', 'ALTERNATE', 'RANDOM'] as const;
export const RELEASES = ['NONE', 'FALL', 'RISE'] as const;
export const AUTO_MODES = [
  'OFF',
  'OCTAVES',
  'WALK',
  'ARP-GLIDE',
  'BREATHE',
  'WANDER',
  'MIRROR',
] as const;
export const AUTO_LOOPS = ['SEQUENCE', 'EVOLVE'] as const;
/** Tempo-synced autopilot rates, in beats per step. */
export const AUTO_DIVS = [
  ['2 BARS', 8],
  ['1 BAR', 4],
  ['1/2', 2],
  ['1/4', 1],
  ['1/8', 0.5],
  ['1/16', 0.25],
] as const;
export const BEND_SHAPES = ['OFF', 'RISE', 'FALL', 'ARCH', 'DIP', 'SAW', 'WOBBLE'] as const;
/** Global bend lengths, in beats. */
export const BEND_LENGTHS = [
  ['1/4', 1],
  ['1/2', 2],
  ['1 BAR', 4],
  ['2 BARS', 8],
  ['4 BARS', 16],
] as const;
export const MOD_DESTS = ['PITCH', 'PRESSURE', 'TIMBRE', 'VIBRATO'] as const;

export type Leading = (typeof LEADING)[number];
export type Curve = (typeof CURVES)[number];
export type Stagger = (typeof STAGGERS)[number];
export type GlidePath = (typeof PATHS)[number];
export type StartDir = (typeof STARTS)[number];
export type ReleaseDir = (typeof RELEASES)[number];
export type AutoMode = (typeof AUTO_MODES)[number];
export type BendShape = (typeof BEND_SHAPES)[number];
export type ModDest = (typeof MOD_DESTS)[number];

const VOICE_COUNTS = Array.from({ length: MAX_VOICES }, (_, i) => String(i + 1));

const PARAMS: ParamDef[] = [
  // VOICES
  sel('voices', 'VOICES', VOICE_COUNTS, 7),
  sel('leading', 'VOICE LEADING', [...LEADING], 0),
  p('legato', 'LEGATO', 0.4),
  // GLIDE
  sel('glideMode', 'GLIDE MODE', [...GLIDE_MODES], 0),
  p('glide', 'GLIDE', 0.45),
  sel('curve', 'CURVE', [...CURVES], 3),
  p('spread', 'SPREAD', 0.25),
  sel('stagger', 'STAGGER', [...STAGGERS], 0),
  p('staggerAmt', 'STAGGER TIME', 0.3),
  sel('path', 'PATH', [...PATHS], 0),
  p('pathDepth', 'PATH DEPTH', 0.3),
  // START / RELEASE
  sel('start', 'START', [...STARTS], 0),
  p('startAmt', 'START BEND', 0.25),
  sel('release', 'RELEASE', [...RELEASES], 0),
  p('releaseAmt', 'RELEASE BEND', 0.3),
  p('releaseTime', 'RELEASE TIME', 0.3),
  // EXPRESSION
  p('swell', 'SWELL', 0.3),
  p('wander', 'TIMBRE WANDER', 0.3),
  p('vibDelay', 'VIB DELAY', 0.4),
  p('vibRate', 'VIB RATE', 0.45),
  p('vibDepth', 'VIB DEPTH', 0.25),
  p('drift', 'DRIFT', 0.2),
  // AUTOPILOT
  sel('auto', 'AUTOPILOT', [...AUTO_MODES], 0),
  p('autoRate', 'AUTO RATE', 0.6),
  rocker('autoSync', 'SYNC', 'orange', true),
  sel('autoLoop', 'LOOP', [...AUTO_LOOPS], 0),
  p('autoDepth', 'AUTO AMOUNT', 1),
  // GLOBAL BEND
  sel('bendShape', 'BEND SHAPE', [...BEND_SHAPES], 0),
  sel(
    'bendLength',
    'BEND LENGTH',
    BEND_LENGTHS.map(([n]) => n),
    2,
  ),
  bi('bendDepth', 'BEND DEPTH', 0.75),
  rocker('bendLoop', 'BEND LOOP', 'white', false),
  // MODULATORS
  p('mod1Rate', 'MOD 1 RATE', 0.35),
  sel('mod1Dest', 'MOD 1 DEST', [...MOD_DESTS], 2),
  p('mod1Depth', 'MOD 1 DEPTH', 0),
  p('mod2Rate', 'MOD 2 RATE', 0.2),
  sel('mod2Dest', 'MOD 2 DEST', [...MOD_DESTS], 1),
  p('mod2Depth', 'MOD 2 DEPTH', 0),
  p('modSpread', 'MOD SPREAD', 0.5),
];

export const MOTION_GEAR: GearDef = {
  kind: 'motion',
  label: 'MOTION-15',
  category: 'midi',
  w: 14,
  h: 7,
  jacks: [
    { id: 'notesIn', dir: 'in', signal: 'note', fx: 0.015, fy: 0.5, label: 'NOTE IN' },
    { id: 'notesOut', dir: 'out', signal: 'note', fx: 0.985, fy: 0.5, label: 'NOTE OUT' },
  ],
  params: PARAMS,
};

// ── Settings ────────────────────────────────────────────

const pick = <T>(list: readonly T[], v: number | undefined): T =>
  list[Math.max(0, Math.min(list.length - 1, Math.round((v ?? 0) * (list.length - 1))))];
const exp = (v: number, lo: number, hi: number) => lo * Math.pow(hi / lo, v);

export interface Mod {
  /** Hz. */
  rate: number;
  dest: ModDest;
  depth: number;
}

export interface MotionSettings {
  voices: number;
  leading: Leading;
  /** Seconds a released voice waits for a new note to glide to before it lets go. */
  legato: number;
  rateMode: boolean;
  /** Glide time in seconds (TIME), or semitones per second (RATE). */
  glide: number;
  curve: Curve;
  spread: number;
  stagger: Stagger;
  /** Seconds between the first and the last voice to move. */
  staggerTime: number;
  path: GlidePath;
  /** Semitones at the middle of a glide. */
  pathDepth: number;
  start: StartDir;
  startBend: number;
  release: ReleaseDir;
  releaseBend: number;
  releaseTime: number;
  /** Seconds for the pressure to swell to full (0 = straight in). */
  swell: number;
  wander: number;
  vibDelay: number;
  vibRate: number;
  /** Semitones. */
  vibDepth: number;
  /** Cents. */
  drift: number;
  auto: AutoMode;
  autoSync: boolean;
  /** Beats per step (SYNC on). */
  autoBeats: number;
  /** Steps per second (SYNC off). */
  autoHz: number;
  evolve: boolean;
  autoAmount: number;
  bendShape: BendShape;
  bendBeats: number;
  /** Semitones, ±12. */
  bendDepth: number;
  bendLoop: boolean;
  mods: Mod[];
  modSpread: number;
}

export function motionSettings(p: Record<string, number>): MotionSettings {
  const v = (id: string, def = 0) => p[id] ?? def;
  const autoRate = v('autoRate', 0.6);
  return {
    voices: VOICE_COUNTS.indexOf(pick(VOICE_COUNTS, v('voices', 0.5))) + 1,
    leading: pick(LEADING, v('leading')),
    legato: v('legato') * 0.4,
    rateMode: pick(GLIDE_MODES, v('glideMode')) === 'RATE',
    glide:
      pick(GLIDE_MODES, v('glideMode')) === 'RATE'
        ? exp(1 - v('glide'), 2, 96)
        : v('glide') * v('glide') * 4,
    curve: pick(CURVES, v('curve')),
    spread: v('spread'),
    stagger: pick(STAGGERS, v('stagger')),
    staggerTime: v('staggerAmt') * v('staggerAmt') * 2,
    path: pick(PATHS, v('path')),
    pathDepth: v('pathDepth') * 12,
    start: pick(STARTS, v('start')),
    startBend: v('startAmt') * 12,
    release: pick(RELEASES, v('release')),
    releaseBend: v('releaseAmt') * 24,
    releaseTime: 0.02 + v('releaseTime') * v('releaseTime') * 2,
    swell: v('swell') * v('swell') * 4,
    wander: v('wander'),
    vibDelay: v('vibDelay') * 3,
    vibRate: exp(v('vibRate'), 1.5, 9),
    vibDepth: v('vibDepth') * v('vibDepth') * 1.5,
    drift: v('drift') * 40,
    auto: pick(AUTO_MODES, v('auto')),
    autoSync: v('autoSync', 1) >= 0.5,
    autoBeats: pick(AUTO_DIVS, autoRate)[1],
    autoHz: exp(autoRate, 0.1, 12),
    evolve: pick(AUTO_LOOPS, v('autoLoop')) === 'EVOLVE',
    autoAmount: v('autoDepth', 1),
    bendShape: pick(BEND_SHAPES, v('bendShape')),
    bendBeats: pick(BEND_LENGTHS, v('bendLength', 0.5))[1],
    bendDepth: (v('bendDepth', 0.5) * 2 - 1) * 12,
    bendLoop: v('bendLoop') >= 0.5,
    mods: [1, 2].map((i) => ({
      rate: exp(v(`mod${i}Rate`), 0.05, 8),
      dest: pick(MOD_DESTS, v(`mod${i}Dest`)),
      depth: v(`mod${i}Depth`),
    })),
    modSpread: v('modSpread'),
  };
}

// ── Randomness ──────────────────────────────────────────

/** A small seeded generator (mulberry32): the same seed gives the same run. */
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

/** A repeatable 0–1 value for an integer pair (a voice and a lattice point). */
export function hash01(a: number, b = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise, −1…+1: random values one unit apart joined by cosine curves. */
export function smoothNoise(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash01(seed, i) * 2 - 1;
  const b = hash01(seed, i + 1) * 2 - 1;
  const w = (1 - Math.cos(f * Math.PI)) / 2;
  return a + (b - a) * w;
}

// ── Voice leading ───────────────────────────────────────

/**
 * Pairs voices (by their current pitch) with new notes. Returns, per voice, the index of the
 * note it moves to, or -1 when it isn't needed; every note gets a voice when there are enough.
 *
 * SMART never crosses voices: both sets in pitch order, the surplus on the side that moves
 * least dropped (or left to new voices). CLASSIC finds the smallest total movement, voices free
 * to cross (each takes whatever's nearest overall).
 */
export function assignVoices(from: number[], to: number[], mode: Leading): number[] {
  const out = from.map(() => -1);
  if (!from.length || !to.length) return out;
  const k = Math.min(from.length, to.length);
  if (mode === 'SMART') {
    const fi = from.map((_, i) => i).sort((a, b) => from[a] - from[b]);
    const ti = to.map((_, i) => i).sort((a, b) => to[a] - to[b]);
    // Choose which k of the larger set take part: the order-preserving subset with the least
    // movement (a small DP over the sorted lists).
    const big = fi.length >= ti.length ? fi : ti;
    const small = big === fi ? ti : fi;
    const bv = big.map((i) => (big === fi ? from[i] : to[i]));
    const sv = small.map((i) => (small === fi ? from[i] : to[i]));
    const n = bv.length;
    const m = sv.length;
    // cost[i][j]: best for the first i of big matched to the first j of small.
    const cost = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
    const take = Array.from({ length: n + 1 }, () => new Array<boolean>(m + 1).fill(false));
    for (let i = 0; i <= n; i++) cost[i][0] = 0;
    for (let i = 1; i <= n; i++)
      for (let j = 1; j <= Math.min(i, m); j++) {
        const skip = cost[i - 1][j];
        const use = cost[i - 1][j - 1] + Math.abs(bv[i - 1] - sv[j - 1]);
        if (use <= skip) {
          cost[i][j] = use;
          take[i][j] = true;
        } else cost[i][j] = skip;
      }
    for (let i = n, j = m; i > 0 && j > 0; i--) {
      if (!take[i][j]) continue;
      const [f, t] = big === fi ? [big[i - 1], small[j - 1]] : [small[j - 1], big[i - 1]];
      out[f] = t;
      j--;
    }
    return out;
  }
  // CLASSIC: minimal total distance. Exact search over the small side for up to 8 pairs, greedy
  // nearest-first beyond that.
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < from.length; i++)
    for (let j = 0; j < to.length; j++) pairs.push([Math.abs(from[i] - to[j]), i, j]);
  if (k <= 8 && from.length * to.length <= 15 * 15) {
    let best = Infinity;
    let bestMap: number[] = [];
    const usedF = new Array<boolean>(from.length).fill(false);
    const map = new Array<number>(from.length).fill(-1);
    const small = to.length <= from.length;
    // Place each item of the smaller set in turn.
    const items = small ? to.length : from.length;
    const other = small ? from.length : to.length;
    const usedO = small ? usedF : new Array<boolean>(to.length).fill(false);
    const rec = (idx: number, sum: number) => {
      if (sum >= best) return;
      if (idx === items) {
        best = sum;
        bestMap = map.slice();
        return;
      }
      for (let o = 0; o < other; o++) {
        if (usedO[o]) continue;
        usedO[o] = true;
        const [f, t] = small ? [o, idx] : [idx, o];
        map[f] = t;
        rec(idx + 1, sum + Math.abs(from[f] - to[t]));
        map[f] = -1;
        usedO[o] = false;
      }
    };
    rec(0, 0);
    return bestMap;
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const fUsed = new Set<number>();
  const tUsed = new Set<number>();
  for (const [, i, j] of pairs) {
    if (fUsed.has(i) || tUsed.has(j)) continue;
    out[i] = j;
    fUsed.add(i);
    tUsed.add(j);
  }
  return out;
}

/**
 * Where a voice moving `from` → `to` should land when bends only reach ±BEND_RANGE from its
 * starting `note`: null means it has to retrigger instead.
 */
export const reachable = (note: number, to: number) =>
  Math.abs(to - note) <= BEND_RANGE ? to - note : null;

// ── Glide shapes ────────────────────────────────────────

/** Glide progress 0…1 → how far along the pitch is (OVERSHOOT passes 1 and settles back). */
export function curveAt(curve: Curve, x: number): number {
  const t = Math.max(0, Math.min(1, x));
  switch (curve) {
    case 'LINEAR':
      return t;
    case 'EASE IN':
      return t * t * t;
    case 'EASE OUT':
      return 1 - (1 - t) ** 3;
    case 'S-CURVE':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    case 'OVERSHOOT': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
    }
  }
}

/**
 * The detour a glide takes, as a fraction of PATH DEPTH (0 at both ends). `sign` flips it per
 * voice (ZIGZAG and SWIRL alternate so neighbours weave). SWIRL also circles the timbre.
 */
export function pathAt(path: GlidePath, x: number, sign = 1): { pitch: number; timbre: number } {
  const t = Math.max(0, Math.min(1, x));
  const env = Math.sin(Math.PI * t);
  switch (path) {
    case 'DIRECT':
      return { pitch: 0, timbre: 0 };
    case 'ARC UP':
      return { pitch: env, timbre: 0 };
    case 'ARC DOWN':
      return { pitch: -env, timbre: 0 };
    case 'ZIGZAG': {
      // Three zigs: a triangle wave inside the arch.
      const ph = (t * 3) % 1;
      const tri = ph < 0.25 ? ph * 4 : ph < 0.75 ? 2 - ph * 4 : ph * 4 - 4;
      return { pitch: sign * env * tri, timbre: 0 };
    }
    case 'SWIRL':
      return {
        pitch: sign * env * Math.sin(4 * Math.PI * t),
        timbre: env * Math.cos(4 * Math.PI * t) * 0.5,
      };
  }
}

/** Glide length in seconds for a move of `distance` semitones. */
export function glideTime(s: Pick<MotionSettings, 'rateMode' | 'glide'>, distance: number) {
  return s.rateMode ? Math.abs(distance) / s.glide : s.glide;
}

/** SPREAD: each voice's glide time scaled by up to ±75 %, the same way every time for a voice. */
export const spreadFactor = (voiceSeed: number, spread: number) =>
  1 + spread * 0.75 * (hash01(voiceSeed, 7919) * 2 - 1);

/**
 * STAGGER: how long each of the moving voices waits before it sets off, given their target
 * pitches. The first to go waits 0, the last `time`.
 */
export function staggerDelays(
  pitches: number[],
  order: Stagger,
  time: number,
  random: () => number = Math.random,
): number[] {
  const n = pitches.length;
  if (order === 'NONE' || n < 2 || time <= 0) return pitches.map(() => 0);
  const byPitch = pitches.map((_, i) => i).sort((a, b) => pitches[a] - pitches[b]);
  let seq: number[];
  switch (order) {
    case 'LOW→HIGH':
      seq = byPitch;
      break;
    case 'HIGH→LOW':
      seq = byPitch.slice().reverse();
      break;
    case 'OUTSIDE IN':
    case 'INSIDE OUT': {
      const out: number[] = [];
      for (let lo = 0, hi = n - 1; lo <= hi; lo++, hi--) {
        out.push(byPitch[lo]);
        if (hi !== lo) out.push(byPitch[hi]);
      }
      seq = order === 'OUTSIDE IN' ? out : out.reverse();
      break;
    }
    case 'RANDOM': {
      seq = byPitch.slice();
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [seq[i], seq[j]] = [seq[j], seq[i]];
      }
      break;
    }
  }
  const delays = new Array<number>(n).fill(0);
  // OUTSIDE IN / INSIDE OUT move in pairs: both ends of a pair set off together.
  const paired = order === 'OUTSIDE IN' || order === 'INSIDE OUT';
  const slots = paired ? Math.ceil(n / 2) : n;
  seq.forEach((v, rank) => {
    let slot = rank;
    if (paired)
      slot = order === 'OUTSIDE IN' ? Math.floor(rank / 2) : Math.floor((rank + (n % 2)) / 2);
    delays[v] = slots > 1 ? (slot / (slots - 1)) * time : 0;
  });
  return delays;
}

/** A new voice's starting bend (START): from below, above, alternating or at random. */
export function startOffset(dir: StartDir, amount: number, index: number, random: () => number) {
  switch (dir) {
    case 'NONE':
      return 0;
    case 'BELOW':
      return -amount;
    case 'ABOVE':
      return amount;
    case 'ALTERNATE':
      return index % 2 ? amount : -amount;
    case 'RANDOM':
      return (random() * 2 - 1) * amount;
  }
}

// ── Expression ──────────────────────────────────────────

/** Pressure starts at this fraction of full when it swells. */
export const SWELL_FLOOR = 0.25;

/** SWELL: the pressure envelope, `t` seconds after the note began. */
export function swellAt(t: number, time: number): number {
  if (time <= 0) return 1;
  const x = Math.max(0, Math.min(1, t / time));
  return SWELL_FLOOR + (1 - SWELL_FLOOR) * (1 - (1 - x) ** 2);
}

/** Delayed vibrato's depth envelope: nothing for `delay` seconds, then a 0.6 s fade in. */
export function vibratoEnv(t: number, delay: number): number {
  return Math.max(0, Math.min(1, (t - delay) / 0.6));
}

/** Vibrato offset in semitones. */
export const vibratoAt = (t: number, delay: number, rate: number, depth: number, phase = 0) =>
  vibratoEnv(t, delay) * depth * Math.sin(2 * Math.PI * (rate * t + phase));

/** DRIFT: slow per-voice pitch noise, in semitones (`cents` at most). */
export const driftAt = (seed: number, t: number, cents: number) =>
  (smoothNoise(seed * 31 + 3, t * 0.25) * cents) / 100;

/** TIMBRE WANDER: slow per-voice timbre movement, ±0.4 at full. */
export const wanderAt = (seed: number, t: number, amount: number) =>
  smoothNoise(seed * 17 + 11, t * 0.35) * amount * 0.4;

/** RELEASE: the bend a voice slides through once let go, `x` 0…1 through RELEASE TIME. */
export function releaseAt(dir: ReleaseDir, amount: number, x: number): number {
  if (dir === 'NONE') return 0;
  const k = Math.max(0, Math.min(1, x)) ** 2;
  return (dir === 'FALL' ? -amount : amount) * k;
}

// ── Global bend ─────────────────────────────────────────

/**
 * The global bend over its length, `x` 0…1, as a fraction of BEND DEPTH. One-shot shapes hold
 * their end value afterwards (unless looped); SAW and WOBBLE are cyclic by nature.
 */
export function bendShapeAt(shape: BendShape, x: number, loop: boolean): number {
  const cyclic = loop || shape === 'SAW' || shape === 'WOBBLE';
  const t = cyclic ? x - Math.floor(x) : Math.min(1, Math.max(0, x));
  switch (shape) {
    case 'OFF':
      return 0;
    case 'RISE':
      return t;
    case 'FALL':
      return -t;
    case 'ARCH':
      return Math.sin(Math.PI * t);
    case 'DIP':
      return -Math.sin(Math.PI * t);
    case 'SAW':
      return 1 - 2 * t;
    case 'WOBBLE':
      return Math.sin(4 * Math.PI * t) * (1 - 0.5 * t);
  }
}

// ── Autopilot ───────────────────────────────────────────

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** A major-scale move of `degrees` steps (either way) in semitones: 2 → 4, 7 → 12, -1 → -1. */
export function degreeSemis(degrees: number): number {
  const d = Math.round(degrees);
  const oct = Math.floor(d / 7);
  return oct * 12 + MAJOR[d - oct * 7];
}

export const DEFAULT_PATTERN = [0, 4, 2, 5, 0, -3, 3, -5];

/** A stored pattern, cleaned: 8 whole steps within ±7 (the default for anything unreadable). */
export function parsePattern(text: string | undefined): number[] {
  try {
    const a = JSON.parse(text ?? '');
    if (Array.isArray(a) && a.length === PATTERN_STEPS && a.every((x) => Number.isFinite(x)))
      return a.map((x) => Math.max(-STEP_MAX, Math.min(STEP_MAX, Math.round(x))));
  } catch {
    // fall through
  }
  return DEFAULT_PATTERN.slice();
}

/** EVOLVE: after each pass, one step moves by one (bounded), so the loop slowly changes. */
export function evolvePattern(pattern: number[], random: () => number): number[] {
  const out = pattern.slice();
  const i = Math.floor(random() * out.length) % out.length;
  const dir = random() < 0.5 ? -1 : 1;
  let v = out[i] + dir * (1 + Math.floor(random() * 2));
  if (v > STEP_MAX || v < -STEP_MAX) v = out[i] - dir;
  out[i] = Math.max(-STEP_MAX, Math.min(STEP_MAX, v));
  return out;
}

/**
 * The autopilot's offset (semitones) for each held voice at step `pos`, given the voices' home
 * pitches. AMOUNT scales how far (WALK, BREATHE, WANDER) or how many voices take part, from the
 * top down (OCTAVES, ARP-GLIDE, MIRROR).
 */
export function autopilotOffsets(
  mode: AutoMode,
  pattern: number[],
  pos: number,
  homes: number[],
  amount: number,
  seed = 0,
): number[] {
  const n = homes.length;
  const out = homes.map(() => 0);
  if (mode === 'OFF' || !n) return out;
  const L = pattern.length || 1;
  const step = (i: number) => pattern[(((pos + i) % L) + L) % L] ?? 0;
  // rank 0 = lowest
  const order = homes.map((_, i) => i).sort((a, b) => homes[a] - homes[b] || a - b);
  const rank = new Array<number>(n);
  order.forEach((v, r) => (rank[v] = r));
  const takesPart = (i: number) => n - 1 - rank[i] < Math.max(1, Math.round(amount * n));
  const clamp = (x: number) => Math.max(-24, Math.min(24, x));
  for (let i = 0; i < n; i++) {
    let o = 0;
    switch (mode) {
      case 'OCTAVES':
        // Each voice reads its own step, so they leap at different times.
        if (takesPart(i)) o = 12 * Math.sign(step(rank[i]));
        break;
      case 'WALK':
        o = degreeSemis(step(0) * amount);
        break;
      case 'ARP-GLIDE': {
        // One voice at a time, bottom to top, steps out by the pattern then comes home.
        const k = ((pos % n) + n) % n;
        if (rank[i] === k && takesPart(i)) o = degreeSemis(step(0) || 7);
        break;
      }
      case 'BREATHE': {
        // Outer voices spread away from the middle (or close in) by up to ±7 semitones.
        const half = (n - 1) / 2;
        o = half ? ((rank[i] - half) / half) * step(0) * amount : 0;
        break;
      }
      case 'WANDER': {
        const span = Math.abs(step(rank[i])) * amount;
        o = degreeSemis((hash01(seed * 997 + i, pos) * 2 - 1) * span);
        break;
      }
      case 'MIRROR': {
        // Positive steps flip the chord upside down about its middle; others bring it home.
        if (step(0) > 0 && takesPart(i)) {
          const c = (homes[order[0]] + homes[order[n - 1]]) / 2;
          o = Math.round(2 * c - homes[i]) - homes[i];
        }
        break;
      }
    }
    out[i] = clamp(o);
  }
  return out;
}

/** Seconds per autopilot step. */
export const autoStepSeconds = (s: MotionSettings, bpm: number) =>
  s.autoSync ? (s.autoBeats * 60) / bpm : 1 / s.autoHz;

// ── Modulators ──────────────────────────────────────────

/** A modulator's value (−1…+1) for the voice in slot `slot`, MOD SPREAD offsetting the phase. */
export const modAt = (m: Mod, t: number, slot: number, spread: number) =>
  Math.sin(2 * Math.PI * (m.rate * t + (slot * spread) / 5));

// ── Presets and dice ────────────────────────────────────

export interface MotionPreset {
  name: string;
  params: Record<string, number>;
  pattern?: number[];
}

const s = (i: number, n: number) => i / (n - 1);

export const PRESETS: MotionPreset[] = [
  { name: 'INIT', params: {} },
  {
    name: 'SLOW MORPH',
    params: {
      glide: 0.7,
      curve: s(3, 5),
      spread: 0.5,
      swell: 0.55,
      vibDelay: 0.6,
      vibDepth: 0.25,
      drift: 0.25,
    },
  },
  {
    name: 'CASCADE',
    params: {
      glide: 0.45,
      curve: s(2, 5),
      stagger: s(1, 6),
      staggerAmt: 0.5,
      path: s(1, 5),
      pathDepth: 0.2,
    },
  },
  {
    name: 'SWIRLY',
    params: { glide: 0.6, path: s(4, 5), pathDepth: 0.35, stagger: s(5, 6), staggerAmt: 0.35 },
  },
  {
    name: 'OCTAVE JUMPS',
    params: { auto: s(1, 7), autoRate: s(3, 6), glide: 0.3, curve: s(4, 5), autoDepth: 0.5 },
  },
  {
    name: 'SCALE WALK',
    params: { auto: s(2, 7), autoRate: s(4, 6), glide: 0.25, autoDepth: 0.6 },
    pattern: [0, 1, 2, 1, 0, -1, -2, -1],
  },
  {
    name: 'GLIDE ARP',
    params: { auto: s(3, 7), autoRate: s(4, 6), glide: 0.3, curve: s(2, 5) },
    pattern: [7, 4, 2, 7, 5, 4, 2, 4],
  },
  {
    name: 'BREATHING',
    params: { auto: s(4, 7), autoRate: s(1, 6), glide: 0.75, curve: s(3, 5), swell: 0.5 },
    pattern: [0, 3, 5, 3, 0, -2, -3, -2],
  },
  {
    name: 'WANDERER',
    params: { auto: s(5, 7), autoRate: s(2, 6), glide: 0.6, autoLoop: 1, drift: 0.35, wander: 0.6 },
  },
  {
    name: 'MIRRORS',
    params: { auto: s(6, 7), autoRate: s(1, 6), glide: 0.55, stagger: s(3, 6), staggerAmt: 0.4 },
    pattern: [0, 1, 0, 1, 1, 0, 1, 0],
  },
  {
    name: 'FALLING',
    params: { release: s(1, 3), releaseAmt: 0.5, releaseTime: 0.5, start: s(2, 5), startAmt: 0.15 },
  },
  {
    name: 'TAPE SICK',
    params: { drift: 0.7, mod1Depth: 0.2, mod1Dest: s(0, 4), mod1Rate: 0.15, vibDepth: 0.1 },
  },
];

/** DICE: a fresh, playable set of settings (the voice count and leading are kept). */
export function dice(random: () => number): { params: Record<string, number>; pattern: number[] } {
  const r = random;
  const choose = (n: number, max = n) => Math.floor(r() * max) / (n - 1);
  const params: Record<string, number> = {
    glideMode: r() < 0.8 ? 0 : 1,
    glide: 0.2 + r() * 0.6,
    curve: choose(5),
    spread: r() * 0.7,
    stagger: choose(6),
    staggerAmt: r() * 0.6,
    path: choose(5),
    pathDepth: r() * 0.5,
    start: choose(5),
    startAmt: r() * 0.4,
    release: choose(3),
    releaseAmt: r() * 0.6,
    releaseTime: r() * 0.6,
    swell: r() * 0.7,
    wander: r(),
    vibDelay: r() * 0.8,
    vibRate: 0.2 + r() * 0.6,
    vibDepth: r() * 0.45,
    drift: r() * 0.5,
    auto: r() < 0.3 ? 0 : choose(7),
    autoRate: choose(6) * 0.6 + 0.2,
    autoLoop: r() < 0.3 ? 1 : 0,
    autoDepth: 0.3 + r() * 0.7,
    bendShape: r() < 0.6 ? 0 : choose(7),
    bendDepth: 0.35 + r() * 0.3,
  };
  const pattern = Array.from({ length: PATTERN_STEPS }, () => Math.round((r() * 2 - 1) * STEP_MAX));
  return { params, pattern };
}

// ── Status (unit → panel) ───────────────────────────────

/** One sounding voice as the display sees it. */
export interface VoiceView {
  id: number;
  /** Current pitch, MIDI note number with fraction. */
  pitch: number;
  pressure: number;
  releasing: boolean;
}

/** Packs the sounding voices (and the autopilot step) into the unit's status line. */
export function encodeStatus(voices: VoiceView[], step: number): string {
  return (
    `${step}|` +
    voices
      .map(
        (v) =>
          `${v.id},${Math.round(v.pitch * 100)},${Math.round(v.pressure * 99)}${v.releasing ? ',r' : ''}`,
      )
      .join(';')
  );
}

export function decodeStatus(text: string | undefined): { step: number; voices: VoiceView[] } {
  if (!text) return { step: -1, voices: [] };
  const [head, body = ''] = text.split('|');
  const voices = body
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const [id, pitch, pressure, r] = part.split(',');
      return { id: +id, pitch: +pitch / 100, pressure: +pressure / 99, releasing: r === 'r' };
    })
    .filter((v) => Number.isFinite(v.id) && Number.isFinite(v.pitch));
  return { step: Number.isFinite(+head) ? +head : -1, voices };
}
