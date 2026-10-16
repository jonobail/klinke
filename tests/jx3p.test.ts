// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEAR, INVENTORY, defaultParams } from '../src/app/core/gear.ts';
import {
  JX3P_GEAR,
  Jx3pVoices,
  SEQ_STEPS,
  type SeqStep,
  addStep,
  decodeSequence,
  encodeSequence,
  jx3pSettings,
  sequenceChunks,
  sequenceFromText,
  stepAt,
} from '../src/app/core/jx3p.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => jx3pSettings({ ...defaultParams('jx3p'), ...over });

/** The voices as the worklet builds them: from the class's own source text. */
function voices(over: Record<string, number> = {}) {
  const Voices = new Function(`return (${Jx3pVoices.toString()})`)() as typeof Jx3pVoices;
  const v = new Voices(48000);
  v.handle({ type: 'params', settings: at(over) });
  return v;
}

function render(v: Jx3pVoices, seconds: number) {
  const out = new Float32Array(Math.round(48000 * seconds));
  for (let i = 0; i < out.length; i += 128) v.render(out, i, Math.min(out.length, i + 128));
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, b) => a + b * b, 0) / x.length);

test('catalog: a synth on the shelf with NOTE IN / OUT, an OUT jack and 61 keys', () => {
  assert.equal(GEAR['jx3p'], JX3P_GEAR);
  assert.equal(JX3P_GEAR.category, 'synth');
  assert.ok(INVENTORY.includes('jx3p'));
  const jacks = JX3P_GEAR.jacks.map((j) => j.id);
  for (const id of ['out', 'notesIn', 'notesOut']) assert.ok(jacks.includes(id), id);
  assert.deepEqual(JX3P_GEAR.keyboard, { from: -12, keys: 61 });
  const ids = JX3P_GEAR.params.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'unique params');
  for (const p of JX3P_GEAR.params) {
    assert.ok(p.default >= 0 && p.default <= 1, p.id);
    if (p.steps) {
      const pos = p.default * (p.steps - 1);
      assert.ok(Math.abs(pos - Math.round(pos)) < 1e-9, `${p.id} default on a position`);
    }
    assert.ok(!/roland/i.test(p.label));
  }
});

test('switches: ranges, waveforms, cross mod, LFO wave, bender range', () => {
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ dco1Range: v }).dco1Ratio),
    [0.5, 1, 2],
  ); // 16' 8' 4'
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ dco1Wave: v }).dco1Wave),
    ['saw', 'pulse', 'square'],
  );
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ dco2Wave: v }).dco2Wave),
    ['saw', 'pulse', 'square', 'noise'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ crossMod: v }).crossMod),
    ['off', 'sync', 'metal'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ lfoWave: v }).lfoWave),
    ['sine', 'square', 'random'],
  );
  // NARROW / MIDDLE / WIDE: ±2 / ±4 / ±7 semitones (MIDI implementation, p.20)
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ benderRange: v }).bendRange),
    [2, 4, 7],
  );
  assert.equal(at({ dco2Tune: 0 }).dco2Semis, -12);
  assert.equal(at({ dco2Tune: 0.5 }).dco2Semis, 0);
  assert.equal(at({ dco2Tune: 1 }).dco2Semis, 12);
  near(at({ dco2Fine: 0 }).dco2Fine, -50);
  assert.ok(at({ envPolarity: 1 }).envDepth < 0);
  assert.ok(at({ vcfPolarity: 1 }).vcfEnv < 0);
  assert.equal(at({ hpf: 0 }).hpf, 5); // fully left: out of the way
});

test('assigner: six voices, a key keeps its voice, the oldest release is taken, then stolen', () => {
  const v = voices();
  for (let n = 60; n < 66; n++) v.noteOn(n, n);
  assert.deepEqual(
    v.voices.map((x) => x.note),
    [60, 61, 62, 63, 64, 65],
  );
  // Release 62 then 64: a new key takes 62's voice (released longest ago).
  v.noteOff(62);
  v.noteOff(64);
  v.noteOn(70, 70);
  assert.equal(v.voices[2].note, 70);
  // 64 pressed again goes back to its own voice.
  v.noteOn(64, 64);
  assert.equal(v.voices[4].note, 64);
  // All six held: a seventh key steals the voice keyed longest ago (60's).
  v.noteOn(72, 72);
  assert.equal(v.voices[0].note, 72);
  assert.equal(v.voices.filter((x) => x.gate).length, 6);
});

test('voices: sound while held, die away after release, stay finite in every cross-mod mode', () => {
  for (const crossMod of [0, 0.5, 1])
    for (const dco2Wave of [0, 1 / 3, 2 / 3, 1])
      for (const dco1Wave of [0, 0.5, 1]) {
        const v = voices({ crossMod, dco2Wave, dco1Wave, resonance: 0.8, release: 0.1 });
        v.noteOn(48, 48);
        v.noteOn(67, 67);
        const held = render(v, 0.3);
        assert.ok(held.every(Number.isFinite));
        assert.ok(rms(held) > 0.01, `audible ${crossMod} ${dco2Wave} ${dco1Wave}`);
        assert.ok(held.every((x) => Math.abs(x) < 4));
        v.noteOff(48);
        v.noteOff(67);
        render(v, 1);
        assert.equal(v.active(), 0);
      }
});

test('MUTE silences the voices; VCA GATE ignores the envelope', () => {
  const muted = voices({ mute: 1 });
  muted.noteOn(60, 60);
  assert.equal(rms(render(muted, 0.1)), 0);
  const gate = voices({ vcaMode: 1, attack: 1, sustain: 0 });
  gate.noteOn(60, 60);
  const out = render(gate, 0.2);
  assert.ok(rms(out.subarray(4800)) > 0.01); // a 5 s attack, but the gate is open
});

test("SYNC follows DCO-1: DCO-2 a fifth up repeats at DCO-1's period only when synced", () => {
  // A3 = 220 Hz: eleven periods are exactly 2400 samples; DCO-2 a fifth up runs ~16½ cycles.
  const drift = (crossMod: number) => {
    const v = voices({
      mix: 1,
      crossMod,
      dco2Tune: 0.5 + 7 / 24,
      dco2Fine: 0.5,
      cutoff: 1,
      vcfEnv: 0,
    });
    v.noteOn(57, 57);
    const out = render(v, 0.5);
    const a = out.subarray(12000, 14000);
    let err = 0;
    for (let i = 0; i < a.length; i++) err += Math.abs(a[i] - out[14400 + i]);
    return err / a.length / rms(a);
  };
  assert.ok(drift(0.5) < 0.05, `synced ${drift(0.5)}`);
  assert.ok(drift(0) > 0.5, `free ${drift(0)}`);
});

test('sequencer: steps, ties, rests, transpose, the 128-step memory', () => {
  const seq: SeqStep[] = [[60, 64, 67], 'tie', [], [62], 'tie', 'tie'];
  assert.deepEqual(stepAt(seq, 0), { notes: [60, 64, 67], steps: 2 });
  assert.deepEqual(stepAt(seq, 1), { notes: [], steps: 1 });
  assert.deepEqual(stepAt(seq, 2), { notes: [], steps: 1 });
  assert.deepEqual(stepAt(seq, 3, 5), { notes: [67], steps: 3 });
  let s: SeqStep[] = [];
  for (let i = 0; i < SEQ_STEPS + 5; i++) s = addStep(s, [i % 128]);
  assert.equal(s.length, SEQ_STEPS);
});

test('sequence text: round trip, split over the 500-character text settings', () => {
  const seq: SeqStep[] = [[60, 64, 67], 'tie', [], [0, 127]];
  assert.equal(encodeSequence(seq), '3c4043 - . 007f');
  assert.deepEqual(decodeSequence(encodeSequence(seq)), seq);
  const big: SeqStep[] = Array.from({ length: SEQ_STEPS }, (_, i) => [
    30 + (i % 40),
    40 + (i % 40),
    50 + (i % 40),
    60 + (i % 40),
    70 + (i % 40),
    80 + (i % 40),
  ]);
  const chunks = sequenceChunks(big);
  for (const v of Object.values(chunks)) assert.ok(v.length <= 500);
  assert.deepEqual(sequenceFromText(chunks), big);
  assert.deepEqual(sequenceFromText({}), []);
  assert.deepEqual(decodeSequence('zz 3c'), [[60]]); // junk ignored
});
