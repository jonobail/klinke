// Shared maths for the DPS-series effects (DPS-D7, DPS-M7, DPS-V55, DPS-V77): knob scaling, LFO
// waveforms as Fourier series (so the audio side can build phase-locked PeriodicWaves), the
// two-tap pitch shifter plan, and deterministic impulse responses for the tap delays and reverbs.
// No Web Audio here, so all of it runs under node --test.

export type Params = Record<string, number>;

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const lerp = (v: number, a: number, b: number) => a + (b - a) * clamp(v, 0, 1);
/** A 0–1 selector value → its position, 0…n-1. */
export const choice = (v: number, n: number) => Math.round(clamp(v, 0, 1) * (n - 1));
/** A centre-detented knob → -1…+1. */
export const bipolar = (v: number) => clamp(v, 0, 1) * 2 - 1;
export const dbGain = (db: number) => Math.pow(10, db / 20);
export const centsRatio = (c: number) => Math.pow(2, c / 1200);
/** Exponential 0–1 → [min, max] (min > 0). */
export const expKnob = (v: number, min: number, max: number) =>
  min * Math.pow(max / min, clamp(v, 0, 1));
/**
 * Delay-time knob: square law, so the musical 20–500 ms range gets most of the travel even on a
 * 2.7 s line. Never below `min` (the DPS lines' shortest setting is 0.021 ms).
 */
export const timeKnob = (v: number, max: number, min = 0) => Math.max(min, max * v * v);

// ── Labels for the display ────────────────────────────────────────────────────────────────────

export const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2)}s` : `${Math.round(s * 1000)}ms`);
export const fmtHz = (hz: number) =>
  hz >= 1000
    ? `${(hz / 1000).toFixed(1)}k`
    : hz >= 10
      ? `${Math.round(hz)}Hz`
      : `${hz.toFixed(2)}Hz`;
export const fmtSigned = (n: number) => (n > 0 ? `+${n}` : String(n));
export const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// ── LFO waveforms ─────────────────────────────────────────────────────────────────────────────

/**
 * The DPS LFO wave forms (DPS-M7 manual p.23 "LFO wave form"; DPS-D7 p.21 "wave select"):
 * sine, triangle, special 1 (rounded humps, ∩∩) and special 2 (the same upside down, ∪∪).
 */
export const LFO_WAVES = ['SIN', 'TRI', 'SP1', 'SP2'] as const;
export type Wave = 0 | 1 | 2 | 3;

/** Fourier coefficients: f(θ) = Σ a[k]·cos kθ + b[k]·sin kθ (index 0 unused: no DC). */
export interface Harmonics {
  a: number[];
  b: number[];
}

export function evalHarmonics(h: Harmonics, theta: number): number {
  let s = 0;
  for (let k = 1; k < h.a.length; k++)
    s += h.a[k] * Math.cos(k * theta) + h.b[k] * Math.sin(k * theta);
  return s;
}

const scaleHarmonics = (h: Harmonics, g: number): Harmonics => ({
  a: h.a.map((x) => x * g),
  b: h.b.map((x) => x * g),
});

/** Scales a wave so its largest excursion is ±1. */
function normalise(h: Harmonics): Harmonics {
  let peak = 0;
  for (let i = 0; i < 512; i++)
    peak = Math.max(peak, Math.abs(evalHarmonics(h, (2 * Math.PI * i) / 512)));
  return peak > 0 ? scaleHarmonics(h, 1 / peak) : h;
}

export function waveHarmonics(wave: Wave, n = 24): Harmonics {
  const a = new Array<number>(n + 1).fill(0);
  const b = new Array<number>(n + 1).fill(0);
  if (wave === 0) b[1] = 1;
  else if (wave === 1) {
    // Triangle in sine phase: odd harmonics, 8/π²k², alternating sign.
    for (let k = 1; k <= n; k += 2)
      b[k] =
        ((k - 1) / 2) % 2 === 0
          ? 8 / (Math.PI * Math.PI * k * k)
          : -8 / (Math.PI * Math.PI * k * k);
  } else {
    // |sin(θ/2)| = 2/π − (4/π) Σ cos kθ / (4k² − 1): one rounded hump per cycle, cusps between.
    const sign = wave === 2 ? 1 : -1;
    for (let k = 1; k <= n; k++) a[k] = (sign * -4) / (Math.PI * (4 * k * k - 1));
  }
  return normalise({ a, b });
}

/** The same wave started `deg` degrees later in its cycle: f(θ + φ). */
export function shiftHarmonics(h: Harmonics, deg: number): Harmonics {
  const phi = (deg * Math.PI) / 180;
  const a = h.a.map((ak, k) => ak * Math.cos(k * phi) + h.b[k] * Math.sin(k * phi));
  const b = h.b.map((bk, k) => bk * Math.cos(k * phi) - h.a[k] * Math.sin(k * phi));
  return { a, b };
}

/** A rising sawtooth, -1 → +1 over the cycle, with its jump at θ = 0. */
export function sawHarmonics(n = 48): Harmonics {
  const a = new Array<number>(n + 1).fill(0);
  const b = new Array<number>(n + 1).fill(0);
  for (let k = 1; k <= n; k++) b[k] = -2 / (Math.PI * k);
  return { a, b };
}

/**
 * The crossfade window for a pitch-shifter tap, minus its 0.5 DC (a GainNode's base value adds
 * that back): 0.5 − 0.5·cos θ is silent exactly where the sawtooth jumps.
 */
export function windowHarmonics(): Harmonics {
  return { a: [0, -0.5], b: [0, 0] };
}

// ── Pitch shifting with two crossfaded delay taps ─────────────────────────────────────────────

/**
 * A delay line read at a moving tap shifts pitch by 1 − d′(t). Two taps sweep a `window` of
 * delay with a sawtooth, half a cycle apart, each faded by `windowHarmonics` so the jumps are
 * silent. Negative ratios play the window backwards (the reverse shifters).
 */
export function pitchPlan(ratio: number, window: number) {
  const slope = 1 - ratio; // d′(t)
  const depth = window / 2;
  return {
    /** Sawtooth rate in Hz. */
    freq: Math.abs(slope) / (2 * depth),
    /** Sawtooth gain in seconds of delay (signed: a falling ramp raises the pitch). */
    amp: slope >= 0 ? depth : -depth,
    /** Base delay so the tap never reaches 0. */
    centre: depth + 0.002,
  };
}

// ── Impulse responses ─────────────────────────────────────────────────────────────────────────

/** xorshift32, so every impulse response is the same on every run. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

/** One delay tap: time in seconds, signed level (negative = phase inverse), pan -1…+1. */
export interface Tap {
  time: number;
  level: number;
  pan: number;
}

/** A sparse stereo impulse response with an equal-power-panned impulse per tap. */
export function tapIR(
  taps: Tap[],
  rate: number,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const len = Math.max(2, Math.ceil(Math.max(0, ...taps.map((t) => t.time)) * rate) + 2);
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  for (const t of taps) {
    const i = Math.round(Math.max(0, t.time) * rate);
    const angle = ((clamp(t.pan, -1, 1) + 1) * Math.PI) / 4;
    l[i] += t.level * Math.cos(angle);
    r[i] += t.level * Math.sin(angle);
  }
  return [l, r];
}

/** Longest reverb impulse we build; longer RT settings fade out over its last part. */
export const MAX_IR_SECONDS = 6;

export interface ReverbShape {
  /** RT60 in seconds. */
  seconds: number;
  preDelay: number;
  /** 0 = bright tail, 1 = the highs die away fast. */
  damp: number;
  /** Room scale 0.6–1.4 (the V55 "Size"): spaces out the early reflections and slows build-up. */
  size: number;
  /** Early-reflection level, 0–1 (plates have none). */
  early: number;
  seed?: number;
}

/**
 * A stereo reverb impulse: seeded noise decaying 60 dB over `seconds`, low-passed harder as it
 * decays (HI DAMP), with a soft build-up and a few discrete early reflections. Normalised to unit
 * energy so changing RT changes the length, not the loudness.
 */
export function reverbIR(shape: ReverbShape, rate: number): Float32Array<ArrayBuffer>[] {
  const rt = clamp(shape.seconds, 0.1, 60);
  const tail = Math.min(rt * 1.1, MAX_IR_SECONDS);
  const pre = Math.round(clamp(shape.preDelay, 0, 1) * rate);
  const n = pre + Math.max(16, Math.floor(tail * rate));
  const fadeFrom = Math.floor(n * 0.85);
  const build = 0.008 * shape.size;
  return [0, 1].map((ch) => {
    const rand = rng((shape.seed ?? 7) * 7919 + ch * 104729);
    const data = new Float32Array(n);
    let lp = 0;
    let a = 1;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / rate;
      if ((i - pre) % 64 === 0) {
        // The tail's cutoff glides from 18 kHz down towards 18 kHz × (300/18000)^damp over RT.
        const fc = 18000 * Math.pow(300 / 18000, shape.damp * Math.min(1, t / rt));
        a = 1 - Math.exp((-2 * Math.PI * Math.min(fc, rate * 0.45)) / rate);
      }
      lp += a * (rand() * 2 - 1 - lp);
      const env = Math.pow(10, (-3 * t) / rt) * (1 - Math.exp(-t / build));
      const fade = i > fadeFrom ? Math.cos(((i - fadeFrom) / (n - fadeFrom)) * (Math.PI / 2)) : 1;
      data[i] = lp * env * fade;
    }
    // Early reflections: eight taps inside the first 10–90 ms × size, alternating sides.
    if (shape.early > 0) {
      for (let k = 0; k < 8; k++) {
        const t = (0.01 + 0.08 * Math.pow((k + rand()) / 8, 1.3)) * shape.size;
        const i = pre + Math.round(t * rate);
        if (i < n)
          data[i] +=
            (rand() < 0.5 ? -1 : 1) * shape.early * 0.6 * (1 - k / 10) * ((k + ch) % 2 ? 0.6 : 1);
      }
    }
    let energy = 0;
    for (let i = 0; i < n; i++) energy += data[i] * data[i];
    const g = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < n; i++) data[i] *= g;
    return data;
  });
}

// ── Saturation ────────────────────────────────────────────────────────────────────────────────

/**
 * Unity-gain tanh over ±`headroom`, for the WaveShaper that keeps every feedback loop bounded
 * (the DSP's 12 dB of internal headroom, DPS-D7 manual p.12). Feed it signal ÷ headroom.
 */
export function tanhCurve(headroom = 4, n = 1025): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: n }, (_, i) => Math.tanh(headroom * ((2 * i) / (n - 1) - 1)));
}

/** |x| for envelope followers (gate, auto-wah, the M7's ENV block). */
export const absCurve = (n = 1025): Float32Array<ArrayBuffer> =>
  Float32Array.from({ length: n }, (_, i) => Math.abs((2 * i) / (n - 1) - 1));

/**
 * A soft gate key: 0 below `threshold`, 1 above, with a short smooth knee, over an input of
 * -1…+1 (an envelope reading). Used as the gate's gain control.
 */
export function gateCurve(threshold: number, n = 1025): Float32Array<ArrayBuffer> {
  const knee = Math.max(0.002, threshold * 0.5);
  return Float32Array.from({ length: n }, (_, i) => {
    const x = Math.abs((2 * i) / (n - 1) - 1);
    const t = clamp((x - (threshold - knee)) / knee, 0, 1);
    return t * t * (3 - 2 * t);
  });
}
