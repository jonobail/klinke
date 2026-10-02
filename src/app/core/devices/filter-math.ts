// Small DSP helpers shared by the H949, DELTA-T and E1010 (pure maths, no Web Audio).

/**
 * Web Audio's low-pass / high-pass BiquadFilterNode reads Q in dB (the peak at the corner), not
 * as a plain ratio: Q_dB = 20·log10(Q). A Butterworth section's Q of 0.7071 is −3.01 dB.
 */
export const qDb = (q: number) => 20 * Math.log10(q);

/** The two section Qs of a 4-pole Butterworth low-pass (−24 dB/oct). */
export const BUTTERWORTH4 = [0.5412, 1.3066] as const;

/**
 * A DelayNode reads its delay at the modulated value, so a delay that changes faster than real
 * time (slope ≥ 1) plays backwards. Largest amplitude `a` (seconds) for a modulation at `hz`
 * whose slope stays under `slew`: a sine's peak slope is 2π·a·hz, a triangle's 4·a·hz.
 */
export const maxModDepth = (hz: number, shape: 'sine' | 'triangle', slew = 0.9) =>
  hz <= 0 ? Infinity : slew / ((shape === 'sine' ? 2 * Math.PI : 4) * hz);
