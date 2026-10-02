// DELTA-T digital delay (model 102-S), after the service manual's schematics (19 photographed
// sheets; page numbers below are the PDF's):
//   p. 1  INP-01 input card: transformer → 15 kHz low-pass (12 kHz on the A versions) → gain-ranging
//         amplifier (0 / +10 / +20 / +30 dB, lines G00A…G11A) → 12-bit ADC (Hybrid Systems 5678).
//   p. 5  CTL-01: the gain-ranging logic (step gain up / down one-shots) and the DOWN 10 / 20 / 30
//         and LIMIT LEDs.
//   p. 7  DM-102-S memory card: shift-register rows tapped every 3 ms, D1 = 3 ms … D15 = 45 ms,
//         multiplexed into "data out A, 3–24 ms" and "data out B, 27–48 ms".
//   p. 2  OM-102 output module (one per output, "1 of 5" on p. 9): coarse switches CS0–2 pick the
//         memory output M01–M08, fine switches FS0–2 the 3 ms tap within it; a 12-bit DAC (DAC-80)
//         + 2-bit gain (G00D…G11D) undo the input ranging; then the 15 kHz reconstruction filter.
//   p. 8  VCO-102 option: an 8038 function generator (FREQ 0.2–20 Hz, AMPLITUDE, DELAY OFFSET)
//         sweeps the master clock between 2.21 and 4.43 MHz; CLOCK MODE = XTAL / MANUAL / sine /
//         triangle / square / EXT.
//   p. 11 TIM-01 timing: 102-S crystal 4.437 MHz.
//
// So the delay of each output is (8 × coarse + fine + 1) × 3 ms, 3–192 ms in 64 steps at the
// crystal clock, and up to twice that when the VCO slows the clock to 2.21 MHz.

import { type GearDef, p, rack, sel } from '../gear-types.ts';
import { expMap } from '../sound.ts';
import { maxModDepth } from './filter-math.ts';

type Params = Record<string, number>;

/** Tap spacing on the memory card (p. 7: D1 3 ms, D2 6 ms … D15 45 ms). */
export const TAP_MS = 3;
/** 8 coarse × 8 fine positions on an output module (p. 2: CS0–2, FS0–2). */
export const STEPS = 64;
/** Output modules modelled (the chassis takes five; three fit the panel). */
export const OUTPUTS = 3;

/** Crystal and VCO range, MHz (p. 8 calibration notes, p. 11 crystal table). */
export const XTAL_MHZ = 4.437;
export const VCO_MIN_MHZ = 2.21;
export const VCO_MAX_MHZ = 4.43;

export const CLOCK_MODES = ['XTAL', 'MANUAL', 'SINE', 'TRI', 'SQUARE'] as const;

/** Knob → output-module step 1…64 (the position of the coarse + fine switches). */
export const tapStep = (v: number) => 1 + Math.min(STEPS - 1, Math.floor(v * STEPS));
export const tapSeconds = (step: number) => (step * TAP_MS) / 1000;

/**
 * The gain ranger: 12-bit samples, with the input amplified by 0, 10, 20 or 30 dB whenever it's
 * small enough, and the gain divided out again after the DAC. The quantising step therefore
 * shrinks with the level: 2/4096 of full scale above −10 dB, ten dB finer for each range below.
 */
export const RANGE_DB = [0, 10, 20, 30] as const;
export const ADC_BITS = 12;

export function gainRange(x: number) {
  const a = Math.abs(x);
  for (let i = RANGE_DB.length - 1; i > 0; i--) {
    const g = Math.pow(10, RANGE_DB[i] / 20);
    if (a * g <= 1) return g;
  }
  return 1;
}

/** One sample through ADC + DAC: gain-ranged, quantised to 12 bits, hard-limited at full scale. */
export function quantise(x: number) {
  const clipped = Math.max(-1, Math.min(1, x));
  const g = gainRange(clipped);
  const step = 2 / (1 << ADC_BITS);
  return (Math.round((clipped * g) / step) * step) / g;
}

/** The converter pair as a WaveShaper curve over −1…+1. */
export const quantiseCurve = (n = 32769): Float32Array<ArrayBuffer> =>
  Float32Array.from({ length: n }, (_, i) => quantise((2 * i) / (n - 1) - 1));

export function deltaTSettings(params: Params) {
  const mode = CLOCK_MODES[Math.round(params['clock'] * (CLOCK_MODES.length - 1))];
  // OFFSET: up = higher clock = shorter delay (p. 8: DELAY CW sets 4.43 MHz, CCW 2.21 MHz).
  const offsetMhz = VCO_MIN_MHZ + (VCO_MAX_MHZ - VCO_MIN_MHZ) * params['offset'];
  const mhz = mode === 'XTAL' ? XTAL_MHZ : offsetMhz;
  // Delay scales with the clock period (all taps together).
  const scale = XTAL_MHZ / mhz;
  const steps = [1, 2, 3].map((n) => tapStep(params[`d${n}`]));
  const taps = steps.map((s) => tapSeconds(s) * scale);
  const swept = mode === 'SINE' || mode === 'TRI' || mode === 'SQUARE';
  const rateHz = expMap(params['rate'], 0.2, 20); // FREQ ×1 range, 0.2–20 Hz (p. 8 calibration)
  // AMPLITUDE: the clock swings around the offset, kept inside the VCO's 2.21–4.43 MHz. As a
  // fraction of each tap's delay (small-signal: delay ∝ 1 / clock).
  const swingMhz = swept
    ? Math.min(
        (params['depth'] * (VCO_MAX_MHZ - VCO_MIN_MHZ)) / 2,
        offsetMhz - VCO_MIN_MHZ,
        VCO_MAX_MHZ - offsetMhz,
      )
    : 0;
  const shape = mode === 'SINE' ? 'sine' : 'triangle';
  const longest = Math.max(...taps);
  const wanted = (swingMhz / mhz) * longest;
  let modFraction = longest > 0 ? Math.min(wanted, maxModDepth(rateHz, shape)) / longest : 0;
  // A square wave steps the clock, but a delay line answers a clock step by sliding over one
  // delay time (the samples already inside keep their spacing): smooth the square with a low-pass
  // at about 1 / (2 × delay), and keep its depth where that slide can't run backwards.
  if (mode === 'SQUARE') modFraction = Math.min(modFraction, 0.25);
  return {
    mode,
    mhz,
    steps,
    taps,
    rateHz,
    /** Modulation depth as a fraction of each tap's delay. */
    modFraction,
    /** Low-pass on the modulation (square only; otherwise wide open). */
    smoothingHz: mode === 'SQUARE' && longest > 0 ? 0.5 / longest : 1000,
    levels: [1, 2, 3].map((n) => params[`l${n}`]),
    /** REGEN (our addition): output 1 recirculated into the memory, kept below unity. */
    regen: params['regen'] * 0.95,
  };
}

export type DeltaTSettings = ReturnType<typeof deltaTSettings>;

const msText = (s: number) => String(Math.round(s * 1000));

export const deltaT: GearDef = rack({
  kind: 'deltaT',
  label: 'DELTA-T',
  subtitle: 'DIGITAL DELAY SYSTEM',
  w: 17,
  h: 3,
  params: [
    p('d1', 'DELAY', 31 / 64),
    p('l1', 'LEVEL', 0.8),
    p('d2', 'DELAY', 63 / 64),
    p('l2', 'LEVEL', 0.5),
    p('d3', 'DELAY', 47 / 64),
    p('l3', 'LEVEL', 0),
    p('regen', 'REGEN', 0.3),
    p('mix', 'MIX', 0.5),
    sel('clock', 'CLOCK', [...CLOCK_MODES], 0),
    p('offset', 'OFFSET', 0.5),
    p('rate', 'FREQ', 0.3),
    p('depth', 'AMPL', 0.3),
  ],
  sections: [
    { title: 'OUTPUT 1', rows: [['d1', 'l1']] },
    { title: 'OUTPUT 2', rows: [['d2', 'l2']] },
    { title: 'OUTPUT 3', rows: [['d3', 'l3']] },
    { title: 'MIX', rows: [['regen', 'mix']] },
    { title: 'CLOCK', rows: [['clock', 'offset']] },
    { title: 'VCO', rows: [['rate', 'depth']] },
  ],
  display: (params) => {
    const s = deltaTSettings(params);
    return `${s.taps.map(msText).join(' ')}\n${s.mode} ${s.mhz.toFixed(3)}`;
  },
  face: { panel: '#2b2d30', text: '#e9e6dc', display: '#ff3b2f' },
});
