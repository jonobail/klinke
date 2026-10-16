// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';
import {
  CHORUS,
  CHORUS_LOWPASS,
  HPF_FREQS,
  JUNO60_GEAR,
  PATCHES,
  VCF_ENV_OCTAVES,
  VCF_LOW,
  VOICES,
  type Channel,
  arpStep,
  arpeggio,
  assignVoice,
  iirGain,
  juno60Settings,
  kybdCents,
  onePoleHighpass,
  parseTranspose,
  pwmBias,
} from '../src/app/core/juno60.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) =>
  juno60Settings({ ...defaultParams('juno60'), ...over });

test('a 61-key synth with NOTE IN / OUT and an OUTPUT, model name only', () => {
  const d = GEAR.juno60;
  assert.equal(d, JUNO60_GEAR);
  assert.equal(d.keyboard?.keys, 61);
  assert.ok(!/roland/i.test(d.label));
  for (const id of ['notesIn', 'notesOut', 'out'])
    assert.ok(
      d.jacks.some((j) => j.id === id),
      id,
    );
  const ids = d.params.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'unique params');
  for (const p of d.params) {
    assert.ok(p.default >= 0 && p.default <= 1, p.id);
    if (p.steps) assert.equal(p.options?.length, p.steps, p.id);
  }
});

test('ranges follow the specification and the adjustment procedures', () => {
  near(at({ lfoRate: 0 }).lfoRate, 0.3);
  near(at({ lfoRate: 1 }).lfoRate, 20);
  near(at({ lfoDelay: 1 }).lfoDelay, 1.5);
  near(at({ arpRate: 0 }).arpRate, 1.5);
  near(at({ arpRate: 1 }).arpRate, 50);
  near(at({ attack: 0 }).attack, 0.001);
  near(at({ attack: 1 }).attack, 3);
  near(at({ decay: 1 }).decay, 12);
  near(at({ release: 0 }).release, 0.002);
  near(at({ tune: 0 }).tuneCents, -50);
  near(at({ dcoLfo: 1 }).dcoLfo, 300); // LFO ±300 cent (p.14)
  near(at({ bendDco: 1 }).bendDco, 700); // BENDER ±700 cent
  near(at({ pw: 0 }).pulseWidth, 0.5); // PWM 50 % … 95 %
  near(at({ pw: 1 }).pulseWidth, 0.05);
  // FREQ 3 with C4 held self-oscillates at 248 Hz (8-2); ENV 10 from FREQ 0 reaches ≈30 kHz.
  near(at({ cutoff: 0.3 }).cutoff, 248, 1e-9);
  near(VCF_LOW * Math.pow(2, VCF_ENV_OCTAVES), 30000, 1e-6);
  assert.ok(at({ envPolarity: 1, vcfEnv: 1 }).vcfEnv < 0);
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ octave: v }).octave),
    [-12, 0, 12],
  );
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ chorus: v }).chorus),
    ['off', 'I', 'II', 'I+II'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ arpRange: v }).arpRange),
    [1, 2, 3],
  );
});

test('KYBD follow pivots on C4 and tracks fully at 10 (8-3, 8-4)', () => {
  assert.equal(kybdCents(60, 1), 0);
  assert.equal(kybdCents(84, 1), 2400); // C4 → C6: two octaves
  assert.equal(kybdCents(84, 0), 0);
});

test('HPF positions from the chorus board capacitors', () => {
  assert.equal(HPF_FREQS[0], 0); // flat
  assert.ok(HPF_FREQS[1] > 225 && HPF_FREQS[1] < 245, `${HPF_FREQS[1]}`);
  assert.ok(HPF_FREQS[2] > 500 && HPF_FREQS[2] < 530, `${HPF_FREQS[2]}`);
  assert.ok(HPF_FREQS[3] > 1050 && HPF_FREQS[3] < 1150, `${HPF_FREQS[3]}`);
  // One pole: −3 dB at the corner, −6 dB per octave below it, flat above.
  const c = onePoleHighpass(500, 48000);
  near(iirGain(c, 500, 48000), Math.SQRT1_2, 1e-3);
  assert.ok(iirGain(c, 50, 48000) < 0.11);
  assert.ok(iirGain(c, 10000, 48000) > 0.99);
});

test('chorus: BBD sweeps and anti-alias filters', () => {
  for (const m of Object.values(CHORUS)) assert.ok(m.min < m.max && m.max < 0.02);
  assert.ok(CHORUS['I+II'].rate > CHORUS.II.rate && CHORUS.II.rate > CHORUS.I.rate);
  for (const f of CHORUS_LOWPASS) assert.ok(f > 9000 && f < 11000, `${f}`);
});

test('PWM bias for a duty cycle', () => {
  near(pwmBias(0.5), 0);
  near(pwmBias(0.05), -0.9);
});

test('key assignment: cyclic CH1–CH6, the 7th key steals the first', () => {
  const free = (): Channel[] =>
    Array.from({ length: VOICES }, () => ({ key: null, down: false, since: 0 }));
  let ch = free();
  let last = VOICES - 1;
  const order: number[] = [];
  for (let k = 0; k < 7; k++) {
    const i = assignVoice(ch, last, 60 + k);
    order.push(i);
    ch[i] = { key: 60 + k, down: true, since: k + 1 };
    last = i;
  }
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 0]);
  // Rotation continues past released channels rather than reusing the last one.
  ch = free();
  ch[0] = { key: 60, down: false, since: 1 };
  assert.equal(assignVoice(ch, 0, 62), 1);
  // Skips held channels.
  ch = free();
  ch[1] = { key: 61, down: true, since: 1 };
  assert.equal(assignVoice(ch, 0, 62), 2);
  // The same key held strikes its own channel again.
  assert.equal(assignVoice(ch, 4, 61), 1);
});

test('arpeggio: UP / U&D / DOWN over 1–3 octaves', () => {
  assert.deepEqual(arpeggio([64, 60, 67], 'up', 1), [60, 64, 67]);
  assert.deepEqual(arpeggio([64, 60], 'up', 2), [60, 64, 72, 76]);
  assert.deepEqual(arpeggio([60, 64], 'down', 2), [76, 72, 64, 60]);
  assert.deepEqual(arpeggio([60, 64, 67], 'updown', 1), [60, 64, 67, 64]);
  assert.deepEqual(arpeggio([60], 'updown', 3), [60, 72, 84, 72]);
  assert.deepEqual(arpeggio([], 'up', 3), []);
});

test('arpeggio clock: RATE, or the song tempo in EXT', () => {
  near(arpStep(at({ arpRate: 0 }), 120), 1 / 1.5);
  near(arpStep(at({ arpClock: 1, arpRate: 0.6 }), 120), 0.125); // 1/16 at 120 BPM
  near(arpStep(at({ arpClock: 1, arpRate: 0.2 }), 120), 0.25); // 1/8
});

test('key transpose text and memory presets', () => {
  assert.equal(parseTranspose('5'), 5);
  assert.equal(parseTranspose('99'), 24);
  assert.equal(parseTranspose('x'), 0);
  assert.equal(parseTranspose(undefined), 0);
  assert.equal(PATCHES.length, 8);
  const ids = new Set(GEAR.juno60.params.map((p) => p.id));
  for (const p of PATCHES)
    for (const [k, v] of Object.entries(p.params)) {
      assert.ok(ids.has(k), `${p.name}: ${k}`);
      assert.ok(v >= 0 && v <= 1, `${p.name}: ${k}`);
    }
});
