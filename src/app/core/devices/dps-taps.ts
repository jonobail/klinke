// Tap patterns for the DPS multi-tap delays, as lists of taps (time, signed level, pan) that the
// audio side turns into a sparse impulse response (`tapIR`). Deterministic: the same settings
// always give the same pattern.

import { type Tap, clamp, rng } from './dps-dsp.ts';

/**
 * A reflection pattern: `n` taps per channel spread from `pre` to `pre + last`, denser early on
 * like a room's reflections (DPS-D7 Algorithm 4 "Tap Delay", manual p.17: 38 taps per channel,
 * each with time, level and phase, "available as a reflection simulator"). `slope` tilts the
 * levels: +1 dies away, 0 is even, -1 builds up. About a quarter of the taps are phase-inverted.
 * The two channels use different seeds, panned left and right.
 */
export function reflectionTaps(
  n: number,
  last: number,
  pre: number,
  slope: number,
  seed = 1,
): Tap[] {
  const count = clamp(Math.round(n), 1, 38);
  const taps: Tap[] = [];
  for (let c = 0; c < 2; c++) {
    const rand = rng(seed * 31 + c * 977 + count);
    const side = c ? 0.8 : -0.8;
    for (let k = 0; k < count; k++) {
      const x = count === 1 ? 1 : (k + 0.2 + 0.6 * rand()) / count;
      const time = pre + Math.max(0.001, last) * Math.pow(Math.min(1, x), 1.3);
      const level = Math.exp(-3 * slope * (count === 1 ? 0 : k / (count - 1)));
      const sign = k > 0 && rand() < 0.25 ? -1 : 1;
      taps.push({ time, level: sign * level, pan: side * (0.6 + 0.4 * rand()) });
    }
  }
  return normaliseTaps(taps);
}

/**
 * Scales the taps so the pattern carries about the energy of a single full-level echo per
 * channel (many taps would otherwise be far louder than the dry sound).
 */
export function normaliseTaps(taps: Tap[], target = 1.2): Tap[] {
  const energy = taps.reduce((s, t) => s + t.level * t.level, 0);
  if (energy <= 0) return taps;
  const g = Math.min(1, target / Math.sqrt(energy / 2));
  return taps.map((t) => ({ ...t, level: t.level * g }));
}

/**
 * The DPS-D7 Long Tap Delay (Algorithm 5, p.18): taps every `spacing` seconds along one line,
 * up to 29, alternating ch1 / ch2 and dying away, plus the full-level tap at the feedback time
 * (`last`), which is what the feedback loop repeats.
 */
export function longTaps(spacing: number, last: number): Tap[] {
  const taps: Tap[] = [];
  const step = Math.max(0.01, spacing);
  for (let k = 1; k <= 29 && k * step < last - 0.005; k++) {
    taps.push({ time: k * step, level: 0.8 * Math.pow(0.85, k - 1), pan: k % 2 ? -0.7 : 0.7 });
  }
  taps.push({ time: last, level: 1, pan: 0 });
  return taps;
}

/**
 * The DPS-D7 Panpot Tap Delay (Algorithm 6, p.19): five taps along the main delay, each with its
 * own panpot. We spread them evenly in time and sweep them left to right, so each repeat walks
 * across the stereo field; the fifth is the main delay output itself.
 */
export function panTaps(main: number): Tap[] {
  return [1, 2, 3, 4, 5].map((k) => ({
    time: (main * k) / 5,
    level: 0.55 + 0.45 * (k / 5),
    pan: -1 + (k - 1) / 2,
  }));
}

/**
 * The V55 Early Reflection (effect 14, p.18): Type 1–4 are four rooms (we use 30, 55, 90 and
 * 140 ms of reflections), Level Mode Dec / Fix / Inc tilts the reflections down, flat or up.
 */
export const ER_SPAN = [0.03, 0.055, 0.09, 0.14];
export function erTaps(type: number, mode: number, pre: number): Tap[] {
  const slope = [1, 0, -1][clamp(Math.round(mode), 0, 2)];
  const span = ER_SPAN[clamp(Math.round(type), 0, 3)];
  return reflectionTaps(12, span, pre + 0.002, slope * 0.6, 5 + Math.round(type));
}
