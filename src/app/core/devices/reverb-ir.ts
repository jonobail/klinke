// Impulse-response building blocks shared by the MODEL 200, DPS-R7 and REV5 reverbs. Each device
// describes its algorithm as early taps + a decaying noise tail; this module renders that into
// one Float32Array per channel for a ConvolverNode. Everything is seeded, so a patch always
// sounds the same, and cheap: one pass over the tail per channel.

/** xorshift32 white noise in -1…+1. */
export function noise(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

/** -60 dB in nepers: an amplitude falls by e^-LN1000 over one RT60. */
const LN1000 = Math.log(1000);

/** The longest impulse we render, in seconds; longer reverb times fade out over its last part. */
export const MAX_IR_SECONDS = 8;

export interface Tail {
  /** When the tail starts (the predelay), in seconds. */
  start: number;
  /** RT60 in the midrange, and in the low and high bands, in seconds. */
  rt: number;
  rtLow?: number;
  rtHigh?: number;
  /** Crossovers between the low / mid / high decay bands, in Hz. */
  xLow?: number;
  xHigh?: number;
  /** Seconds for the echo density to build up to a smooth wash: low diffusion = longer. */
  density: number;
  /** Seconds for the tail's level to rise (the "build-up" of the space). */
  attack: number;
  /** 0 = both channels identical (mono), 1 = fully decorrelated. */
  width: number;
  gain?: number;
  /**
   * Overrides the exponential decay with an amplitude shape over the tail's own time (gate and
   * reverse programs); the band RTs then only colour it.
   */
  shape?: (t: number) => number;
  /** Seconds after `start` at which the tail stops (a gate); default: when it has decayed. */
  stop?: number;
}

export interface Tap {
  /** Seconds. */
  t: number;
  gain: number;
  /** 0 = left, 1 = right, undefined = both. */
  ch?: 0 | 1;
}

/** Seconds needed to hold a tail (to -60 dB, or to its gate), capped at MAX_IR_SECONDS. */
export function tailSeconds(tail: Tail) {
  const longest = Math.max(tail.rt, tail.rtLow ?? 0, tail.rtHigh ?? 0);
  const end = tail.start + (tail.stop ?? longest) + 0.01;
  return Math.min(end, MAX_IR_SECONDS);
}

/** A stereo impulse with these taps and tail, `rate` samples per second. */
export function renderImpulse(
  rate: number,
  taps: Tap[],
  tail: Tail | null,
  seed = 1,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const tapEnd = taps.reduce((m, t) => Math.max(m, t.t), 0) + 0.005;
  const seconds = Math.min(Math.max(tapEnd, tail ? tailSeconds(tail) : 0), MAX_IR_SECONDS);
  const length = Math.max(1, Math.ceil(seconds * rate));
  const out: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  for (const tap of taps) {
    const i = Math.round(tap.t * rate);
    if (i >= length) continue;
    if (tap.ch !== 1) out[0][i] += tap.gain;
    if (tap.ch !== 0) out[1][i] += tap.gain;
  }
  if (tail) addTail(out, rate, tail, seed);
  return out;
}

/**
 * Adds a three-band exponentially decaying noise tail. White noise is split by two one-pole
 * low-passes into low / mid / high bands (which sum back to the noise), each band decays at its
 * own RT, and the noise starts sparse (single echoes) and fills in over `density` seconds.
 */
function addTail(out: Float32Array[], rate: number, tail: Tail, seed: number) {
  const length = out[0].length;
  const i0 = Math.round(tail.start * rate);
  const iStop = tail.stop !== undefined ? i0 + Math.round(tail.stop * rate) : length;
  const end = Math.min(length, iStop);
  if (end <= i0) return;
  const k = (rt: number) => Math.exp(-LN1000 / (Math.max(rt, 0.01) * rate));
  const kM = k(tail.rt);
  const kL = k(tail.rtLow ?? tail.rt);
  const kH = k(tail.rtHigh ?? tail.rt);
  const aL = onePoleCoef(tail.xLow ?? 250, rate);
  const aH = onePoleCoef(tail.xHigh ?? 4000, rate);
  const attack = Math.max(tail.attack, 1e-4) * rate;
  const dens = Math.max(tail.density, 1e-4) * rate;
  // The last 15 % of a capped tail fades out, so a long RT doesn't end in a click.
  const fadeFrom = end - Math.round((end - i0) * 0.15);
  const capped = tail.stop === undefined && tailSeconds(tail) >= MAX_IR_SECONDS;
  const gate = tail.stop !== undefined ? Math.min(end - i0, Math.round(0.004 * rate)) : 0;
  // Scale the tail to unit energy, so tap gains are relative to the whole reverberant tail.
  const gain = (tail.gain ?? 1) / Math.sqrt(tailEnergy(tail, (end - i0) / rate) * rate);
  // With a `shape`, the mid band follows it and the low / high bands decay relative to it.
  const rel = tail.shape ? 1 / kM : 1;
  const common = noise(seed * 7919 + 1);
  const own = [noise(seed * 104729 + 2), noise(seed * 15485863 + 3)];
  const mask = noise(seed * 31 + 5);
  const w = Math.min(1, Math.max(0, tail.width));
  const cw = Math.sqrt(1 - w * w);
  const lpL = [0, 0];
  const lpH = [0, 0];
  let gL = gain;
  let gM = gain;
  let gH = gain;
  for (let i = i0; i < end; i++) {
    const n = i - i0;
    // Sparse at first: a sample is an echo with probability p, scaled to keep the energy.
    const p = Math.min(1, 0.002 + (n / dens) * (n / dens));
    const hit = Math.abs(mask()) < p;
    const c0 = common();
    const o0 = own[0]();
    const o1 = own[1]();
    let env = 1 - Math.exp(-n / attack);
    if (tail.shape) env *= tail.shape(n / rate);
    if (capped && i >= fadeFrom) {
      env *= 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeFrom)) / (end - fadeFrom));
    }
    if (gate && i >= end - gate) env *= (end - i) / gate;
    for (let c = 0; c < 2; c++) {
      const v = hit ? (c0 * cw + (c === 0 ? o0 : o1) * w) / Math.sqrt(p) : 0;
      lpL[c] += aL * (v - lpL[c]);
      lpH[c] += aH * (v - lpH[c]);
      const y = lpL[c] * gL + (lpH[c] - lpL[c]) * gM + (v - lpH[c]) * gH;
      out[c][i] += y * env;
    }
    gL *= kL * rel;
    gM *= kM * rel;
    gH *= kH * rel;
  }
}

/** Energy per sample-rate of a unit tail lasting `seconds`: ∫ envelope² dt. */
function tailEnergy(tail: Tail, seconds: number) {
  if (tail.shape) {
    let e = 0;
    const steps = 256;
    for (let i = 0; i < steps; i++) e += tail.shape(((i + 0.5) / steps) * seconds) ** 2;
    return Math.max((e / steps) * seconds, 1e-6);
  }
  const rt = Math.max(tail.rt, 0.01);
  return Math.max((rt / (2 * LN1000)) * (1 - Math.exp((-2 * LN1000 * seconds) / rt)), 1e-6);
}

/** Coefficient of a one-pole low-pass `y += a (x - y)` with its corner at `hz`. */
export const onePoleCoef = (hz: number, rate: number) =>
  1 - Math.exp((-2 * Math.PI * Math.min(hz, rate / 2)) / rate);

/** Runs a 6 dB/octave one-pole low-pass over each channel in place. */
export function lowPass(channels: Float32Array[], hz: number, rate: number) {
  const a = onePoleCoef(hz, rate);
  for (const d of channels) {
    let y = 0;
    for (let i = 0; i < d.length; i++) d[i] = y += a * (d[i] - y);
  }
}

/**
 * Estimates the RT60 of an impulse from its Schroeder backward-integrated energy curve: the time
 * from -5 dB to -25 dB, ×3 (a "T20"). For checking the generators in tests.
 */
export function measureRt(data: Float32Array, rate: number) {
  const e = new Float64Array(data.length);
  let sum = 0;
  for (let i = data.length - 1; i >= 0; i--) e[i] = sum += data[i] * data[i];
  const total = e[0];
  const at = (db: number) => {
    const target = total * Math.pow(10, db / 10);
    for (let i = 0; i < e.length; i++) if (e[i] <= target) return i / rate;
    return e.length / rate;
  };
  return (at(-25) - at(-5)) * 3;
}

/** Energy of a channel between two times, in seconds. */
export function energy(data: Float32Array, rate: number, from = 0, to = Infinity) {
  let s = 0;
  const end = Math.min(data.length, Math.round(to * rate));
  for (let i = Math.round(from * rate); i < end; i++) s += data[i] * data[i];
  return s;
}
