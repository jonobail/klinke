// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COARSE_STEPS,
  RATE,
  SAMPLE_FUNCTIONS,
  SETUP_FUNCTIONS,
  SOUND_IDS,
  ZONE_SAMPLES,
  channelFilter,
  coarseOf,
  decaySeconds,
  fineOf,
  fitZone,
  formatStatus,
  kitSound,
  largestFree,
  lcdLine,
  padForStep,
  parseStatus,
  pitchRatio,
  quantize12,
  region,
  renderPitched,
  sampleLength,
  thresholdIndex,
  thresholdLevel,
  toSpMemory,
  withCoarse,
  withFine,
} from '../src/app/core/sp1200.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('32 sound locations A1–D8; channels 1–2 dynamic, 3–6 fixed, 7–8 unfiltered', () => {
  assert.equal(SOUND_IDS.length, 32);
  assert.deepEqual([SOUND_IDS[0], SOUND_IDS[8], SOUND_IDS[31]], ['A1', 'B1', 'D8']);
  assert.deepEqual([1, 2, 3, 6, 7, 8].map(channelFilter), [
    'dynamic',
    'dynamic',
    'fixed',
    'fixed',
    'none',
    'none',
  ]);
});

test('12-bit quantisation: 4096 levels, clipping flagged', () => {
  assert.deepEqual(quantize12(0.5), { value: 0.5, clipped: false });
  near(quantize12(0.0003).value, 1 / 2048);
  assert.equal(quantize12(1.2).clipped, true);
  assert.equal(quantize12(1.2).value, 2047 / 2048);
  assert.equal(quantize12(-1).value, -1);
});

test('capture resamples to 26.04 kHz and reports overload', () => {
  const src = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10) * 0.5);
  const { data, overload } = toSpMemory(src, 48000);
  assert.equal(data.length, RATE);
  assert.equal(overload, false);
  assert.equal(toSpMemory(new Float32Array(480).fill(1.5), 48000).overload, true);
});

test('pitch: skipping / repeating samples, ± a fifth, held between ticks', () => {
  near(pitchRatio(0.5), 1);
  near(pitchRatio(1), Math.pow(2, 7 / 12));
  near(pitchRatio(0), Math.pow(2, -7 / 12));
  const ramp = Float32Array.from({ length: 100 }, (_, i) => i / 100);
  // An octave up plays every other sample, so the sound lasts half as long.
  const up = renderPitched(ramp, 2, RATE);
  assert.equal(up.length, 50);
  assert.deepEqual([up[0], up[1], up[2]], [ramp[0], ramp[2], ramp[4]]);
  // An octave down plays each sample twice.
  const down = renderPitched(ramp, 0.5, RATE);
  assert.equal(down.length, 200);
  assert.deepEqual([down[0], down[1], down[2], down[3]], [ramp[0], ramp[0], ramp[1], ramp[1]]);
  // At a higher output rate each tick is held (zero-order hold), no interpolation.
  const held = renderPitched(ramp, 1, RATE * 2);
  assert.equal(held[0], held[1]);
  assert.equal(held[2], ramp[1]);
});

test('truncation and looping: regions, and a loop that repeats until the cap', () => {
  const r = region(1000, 0.1, 0.5, 0.2);
  assert.deepEqual(r, { start: 100, end: 500, loop: 200 });
  assert.equal(region(1000, 0, 0.1, 0.5).loop, 100); // never longer than the sound
  const data = Float32Array.from({ length: 10 }, (_, i) => i);
  const looped = renderPitched(data, 1, RATE, { start: 0, end: 10, loop: 4 }, 20 / RATE);
  assert.deepEqual(
    Array.from(looped),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 6, 7, 8, 9, 6, 7, 8, 9, 6, 7],
  );
});

test('memory: four 2.5 s zones, sounds never straddle two', () => {
  assert.equal(ZONE_SAMPLES, 65100);
  // §4E's example: four 2.0 s sounds leave 0.5 s in each zone, so 1.0 s won't fit but 0.5 s will.
  const two = Math.round(2 * RATE);
  const used = [two, two, two, two];
  assert.equal(fitZone(used, Math.round(1 * RATE)), -1);
  assert.equal(fitZone(used, Math.round(0.5 * RATE)), 0);
  near(largestFree(used), 0.5, 1e-3);
  near(largestFree([0, 0, 0, 0]), 2.5, 1e-3);
});

test('controls: sample length 0.1–2.5 s in 0.1 s steps, threshold -60…0 dB, decay around the centre', () => {
  assert.equal(sampleLength(0), 0.1);
  assert.equal(sampleLength(1), 2.5);
  assert.equal(sampleLength(0.5), 1.3);
  near(thresholdLevel(1), 1);
  near(thresholdLevel(0), 0.001);
  near(decaySeconds(0.5, 0.4), 0.4);
  near(decaySeconds(0, 0.4), 0.02);
  assert.ok(decaySeconds(1, 0.4) > 3);
  assert.equal(thresholdIndex(Float32Array.of(0, 0.01, 0.2, 0.9), 0.1), 2);
  assert.equal(thresholdIndex(Float32Array.of(0, 0.01), 0.1), -1);
});

test('pads from the home row: C D E F G A B C → pads 1–8, black keys play nothing', () => {
  assert.deepEqual([0, 2, 4, 5, 7, 9, 11, 12].map(padForStep), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(padForStep(1), -1);
});

test('stand-in kit: eight short 12-bit sounds, deterministic', () => {
  for (let i = 0; i < 8; i++) {
    const s = kitSound(i);
    assert.ok(s.length > 0 && s.length <= ZONE_SAMPLES, `sound ${i}`);
    assert.ok(
      s.every((x) => x >= -1 && x < 1 && Number.isInteger(x * 2048)),
      `sound ${i} is 12-bit`,
    );
    assert.ok(
      s.some((x) => Math.abs(x) > 0.2),
      `sound ${i} is audible`,
    );
  }
  assert.deepEqual(kitSound(1), kitSound(1));
});

test('panel: module functions as printed, 16-column LCD lines', () => {
  assert.deepEqual(
    SETUP_FUNCTIONS.map((f) => f.key),
    [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  );
  assert.equal(SETUP_FUNCTIONS.find((f) => f.key === 19)?.name, 'Loop/Truncate');
  assert.deepEqual(
    SAMPLE_FUNCTIONS.map((f) => f.key),
    [1, 2, 3, 4, 5, 6, 7, 9],
  );
  assert.equal(lcdLine('Sample is good'), 'Sample is good  ');
  assert.equal(lcdLine('Make Truncation Permanent'), 'Make Truncation ');
});

test('SET-UP 19 coarse / fine sliders cover the sound and keep each other', () => {
  for (const v of [0, 0.2, 0.5, 0.731, 1]) {
    // Moving either slider to where it already is changes nothing.
    near(withCoarse(v, coarseOf(v)), v, 1e-9);
    near(withFine(v, fineOf(v)), v, 1e-9);
  }
  // Coarse picks a block, fine moves within it.
  near(withCoarse(0.3, 0), fineOf(0.3) / COARSE_STEPS, 1e-9);
  near(withFine(0, 1), 1 / COARSE_STEPS);
  assert.equal(withCoarse(0, 1), (COARSE_STEPS - 1) / COARSE_STEPS);
  assert.equal(withFine(withCoarse(0, 1), 1), 1);
});

test('status line: display text plus phase, sound length and free memory', () => {
  const text = formatStatus({
    top: 'A1* +00dB 2.5s',
    vu: '||||............',
    phase: 'armed',
    length: 26040,
    free: 1.5,
  });
  assert.equal(text.split('\n').length, 3);
  assert.deepEqual(parseStatus(text), {
    top: 'A1* +00dB 2.5s',
    vu: '||||............',
    phase: 'armed',
    length: 26040,
    free: 1.5,
  });
  assert.equal(parseStatus(undefined), null);
  assert.equal(parseStatus('A1\nVU')?.phase, 'idle');
});
