// Shared maths for the synths: selector positions, single-cycle waves → Web Audio periodic-wave
// coefficients, noise colours and monophonic key assignment.

export const stepIndex = (v: number, steps: number) => Math.round(v * (steps - 1));

/** One cycle of a pulse wave with the given duty cycle (high for the first `duty` of the cycle). */
export const pulseSamples = (duty: number, n = 1024) =>
  Float32Array.from({ length: n }, (_, i) => (i / n < duty ? 1 : -1));

/**
 * Fourier coefficients of one cycle, in the shape `createPeriodicWave(real, imag)` wants:
 * real = cosine terms, imag = sine terms, index 0 is DC (left at 0).
 */
export function fourier(samples: ArrayLike<number>, harmonics: number) {
  const n = samples.length;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let h = 1; h <= harmonics; h++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * h * i) / n;
      re += samples[i] * Math.cos(a);
      im += samples[i] * Math.sin(a);
    }
    real[h] = (2 * re) / n;
    imag[h] = (2 * im) / n;
  }
  return { real, imag };
}

/**
 * Pink noise (−3 dB / octave) from seeded white noise, using Paul Kellet's economy filter.
 * Deterministic, so a patch always sounds the same.
 */
export function pinkNoise(length: number, seed = 7): Float32Array<ArrayBuffer> {
  let s = seed >>> 0 || 1;
  const white = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    const w = white();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return out;
}

/**
 * Monophonic key assignment. The MS-20 plays the newest held key (last-note priority); the
 * Model D plays the lowest (low-note priority). Both are single-trigger: the envelopes fire only
 * when playing from silence, so legato lines glide without re-attacking, and lifting a key falls
 * back to one still held.
 */
export class MonoKeys {
  private held: number[] = [];
  private readonly priority: 'last' | 'low';

  constructor(priority: 'last' | 'low' = 'last') {
    this.priority = priority;
  }

  private sounding(): number | null {
    if (!this.held.length) return null;
    return this.priority === 'low' ? Math.min(...this.held) : this.held[this.held.length - 1];
  }

  /** Returns the note to sound and whether the envelopes should trigger. */
  press(note: number): { note: number; trigger: boolean } {
    const trigger = this.held.length === 0;
    this.held = [...this.held.filter((n) => n !== note), note];
    return { note: this.sounding()!, trigger };
  }

  /** Returns the note to sound next, or null when the last key is up (release the envelopes). */
  lift(note: number): { note: number | null; changed: boolean } {
    const before = this.sounding();
    this.held = this.held.filter((n) => n !== note);
    const next = this.sounding();
    return { note: next, changed: next !== before };
  }

  clear() {
    this.held = [];
  }
}
