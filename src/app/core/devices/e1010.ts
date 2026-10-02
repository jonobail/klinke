// E1010 analog delay, after the service manual (14 pp.: front panel p. 1, electrical performance
// p. 3, block diagram and specifications p. 6, schematic p. 8).
//
// Block diagram (p. 6): INPUT volume → TONE CONTROL (BASS 70 Hz / TREBLE 7 kHz, ±12 dB) → summed
// with FEEDBACK → 13 kHz −24 dB/oct LPF → pre-emphasis → NE570 compressor → BBD chain → expander →
// de-emphasis → 13 kHz LPF → FEEDBACK, and through the switched passive −12 dB/oct "delay output
// filter" to the MIXING (DIRECT ↔ DELAY) pot. The BBD chain is one MN3004 (512 stages) and four
// MN3005s (4096 stages each), tapped by the five DELAY TIME RANGE push buttons. One voltage
// controlled clock drives them all, swept by the DELAY knob and a triangle LFO (MODULATION
// FREQUENCY / DEPTH).

import { type GearDef, bi, p, rack, sel } from '../gear-types.ts';
import { expMap } from '../sound.ts';
import { maxModDepth } from './filter-math.ts';

type Params = Record<string, number>;

/** The DELAY TIME selector (p. 1 front panel, p. 6 specifications), in ms. */
export const RANGES = [10, 75, 150, 225, 300] as const;

/** BBD stages behind each range tap (p. 6 block diagram): 512, then 1–4 × 4096. */
export const STAGES = [512, 4096, 2 * 4096, 3 * 4096, 4 * 4096] as const;

/**
 * Clock limits, from the waveforms printed on the schematic (p. 8, E-6): DELAY LONG t = 36.6 µs
 * (27.3 kHz), DELAY SHORT t = 12.2 µs (82 kHz). Each tap delays by stages / (2 × clock).
 */
export const CLOCK_LONG = 27.3e3;
export const CLOCK_SHORT = 82e3;

export const bbdDelay = (stages: number, clock: number) => stages / (2 * clock);

/** The passive LPF's series resistance: not printed; fitted to Table-1 (p. 3), see the doc. */
export const PASSIVE_R = 1400;

/**
 * The switched capacitors of the delay output filter (p. 8, "DELAY Selector Switch"): none on
 * 10 / 75 ms, 0.018 / 0.01 µF on 150 ms, 0.022 / 0.012 µF on 225 and 300 ms.
 */
export const PASSIVE_C: (readonly [number, number] | null)[] = [
  null,
  null,
  [0.018e-6, 0.01e-6],
  [0.022e-6, 0.012e-6],
  [0.022e-6, 0.012e-6],
];

/**
 * A two-section RC ladder (R, C1, R, C2) as a biquad low-pass: the denominator is
 * 1 + s·R(C1 + 2·C2) + s²·R²·C1·C2, so f0 = 1 / (2πR√(C1C2)) and Q = √(C1C2) / (C1 + 2·C2).
 */
export function rcLadder(r: number, c1: number, c2: number) {
  const rc = Math.sqrt(c1 * c2);
  return { hz: 1 / (2 * Math.PI * r * rc), q: rc / (c1 + 2 * c2) };
}

/** Its gain in dB at `hz` (to check against Table-1). */
export function rcLadderDb(r: number, c1: number, c2: number, hz: number) {
  const w = 2 * Math.PI * hz;
  const re = 1 - w * w * r * r * c1 * c2;
  const im = w * r * (c1 + 2 * c2);
  return -20 * Math.log10(Math.hypot(re, im));
}

/** MODULATION DEPTH at full scale, as a fraction of the delay (p. 6: 10 % at 10 ms, 30 % at 300 ms). */
export const DEPTH_MAX = [0.1, 0.15, 0.2, 0.25, 0.3] as const;

export function e1010Settings(p: Params) {
  const range = Math.round(p['range'] * (RANGES.length - 1));
  const stages = STAGES[range];
  // DELAY knob: SHORT = fastest clock, LONG = slowest. The VCO law isn't printed; exponential here.
  const clock = expMap(1 - p['delay'], CLOCK_LONG, CLOCK_SHORT);
  const seconds = bbdDelay(stages, clock);
  const rateHz = expMap(p['rate'], 0.5, 10); // MODULATION FREQUENCY 0.5–10 Hz (p. 6)
  // DEPTH is a peak-to-peak swing. A BBD's clock never runs backwards, so the delay can't change
  // faster than real time: the swing is capped to keep the triangle's slope under 0.9 (our limit).
  const wanted = (p['depth'] * DEPTH_MAX[range] * seconds) / 2;
  const c = PASSIVE_C[range];
  return {
    range,
    seconds,
    clock,
    rateHz,
    /** Triangle amplitude (half the peak-to-peak swing), in seconds of delay. */
    modDepth: Math.min(wanted, maxModDepth(rateHz, 'triangle')),
    /** Up to a little past unity: the repeats can build into runaway, held by the line's overload. */
    feedback: p['feedback'] * 1.05,
    bassDb: (p['bass'] * 2 - 1) * 12,
    trebleDb: (p['treble'] * 2 - 1) * 12,
    /** The delay output filter, or null when the range has no capacitors switched in. */
    outFilter: c ? rcLadder(PASSIVE_R, c[0], c[1]) : null,
  };
}

export type E1010Settings = ReturnType<typeof e1010Settings>;

export const e1010: GearDef = rack({
  kind: 'e1010',
  label: 'E1010',
  subtitle: 'ANALOG DELAY',
  w: 17,
  h: 3,
  params: [
    p('input', 'INPUT', 0.75),
    bi('bass', 'BASS'),
    bi('treble', 'TREBLE'),
    p('delay', 'DELAY', 0.5),
    sel(
      'range',
      'RANGE',
      RANGES.map((r) => `${r}MS`),
      2,
    ),
    p('feedback', 'FEEDBACK', 0.35),
    p('mix', 'MIXING', 0.5),
    p('rate', 'FREQ', 0.3),
    p('depth', 'DEPTH', 0),
  ],
  sections: [
    { title: 'INPUT', rows: [['input']] },
    { title: 'TONE', rows: [['bass', 'treble']] },
    { title: 'DELAY', rows: [['delay', 'range']] },
    { title: 'MIXING', rows: [['feedback', 'mix']] },
    { title: 'MODULATION', rows: [['rate', 'depth']] },
  ],
  display: (params) => {
    const s = e1010Settings(params);
    return `${(s.seconds * 1000).toFixed(1)} MS\nRANGE ${RANGES[s.range]}`;
  },
  face: { panel: '#c9c6bd', text: '#1d1d1b', display: '#e0442c' },
});
