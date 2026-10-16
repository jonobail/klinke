// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import {
  SH2_GEAR,
  envTriggers,
  lfoDelayDepth,
  roundedTriangle,
  sh2Settings,
} from '../src/app/core/sh2.ts';
import { MonoKeys } from '../src/app/core/synth.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => sh2Settings({ ...defaultParams('sh2'), ...over });

test('ranges follow the specification', () => {
  near(at({ lfoRate: 0 }).lfoRate, 0.2);
  near(at({ lfoRate: 1 }).lfoRate, 25);
  near(at({ lfoDelay: 1 }).lfoDelay, 1.5);
  near(at({ cutoff: 0 }).cutoff, 10);
  near(at({ cutoff: 1 }).cutoff, 20000);
  near(at({ attack: 0 }).attack, 0.001);
  near(at({ attack: 1 }).attack, 2.5);
  near(at({ decay: 0 }).decay, 0.002);
  near(at({ decay: 1 }).decay, 10);
  near(at({ release: 1 }).release, 10);
  near(at({ pulseWidth: 0 }).pulseWidth, 0.5);
  assert.ok(at({ pulseWidth: 1 }).pulseWidth < 0.1);
  assert.equal(at({ portaTime: 0 }).portaTime, 0);
  near(at({ portaTime: 1 }).portaTime * 4, 5);
  assert.equal(at({ autoBend: 0 }).autoBend, 0);
  for (const id of ['range1', 'range2'] as const) {
    assert.deepEqual(
      [0, 0.25, 0.5, 0.75, 1].map((v) => at({ [id]: v })[id === 'range1' ? 'ratio1' : 'ratio2']),
      [0.25, 0.5, 1, 2, 4],
    ); // 32'–2'
  }
});

test('switches: waveforms, LFO mode, PWM, VCF envelope, VCA, gate selector, bender', () => {
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ wave1: v }).wave1),
    ['sine', 'saw', 'square', 'pulse'],
  );
  assert.deepEqual(
    [0, 1 / 3, 2 / 3, 1].map((v) => at({ wave2: v }).wave2),
    ['noise', 'saw', 'square', 'pulse'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ lfoWave: v }).lfoWave),
    ['sine', 'square', 'random'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ pwmSource: v }).pwmSource),
    ['lfo', 'man', 'env'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ vcfEnvSource: v }).vcfEnvSource),
    ['follower', 'env', 'inverted'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ vcaMode: v }).vcaMode),
    ['hold', 'env', 'gate'],
  );
  assert.deepEqual(
    [0, 0.5, 1].map((v) => at({ envTrigger: v }).envTrigger),
    ['gateTrig', 'gate', 'lfo'],
  );
  assert.equal(at({ bendVco1: 1 }).bendVco1, true);
  assert.equal(at({ bendVco1: 0 }).bendVco1, false);
});

test('VCO-2 TUNE: WIDE ±1 octave, NARROW ±1 semitone; centred is in tune', () => {
  near(at({ tune2: 1, tuneRange: 0 }).tune2Cents, 1200);
  near(at({ tune2: 0, tuneRange: 1 }).tune2Cents, -100);
  near(at({ tune2: 0.5 }).tune2Cents, 0);
});

test('low-note priority, retriggered by every change of the key voltage in GATE+TRIG', () => {
  const keys = new MonoKeys('low');
  assert.equal(keys.press(60).note, 60);
  assert.equal(keys.press(67).note, 60); // a higher key doesn't take over
  assert.equal(keys.press(55).note, 55); // a lower one does
  assert.deepEqual(keys.lift(55), { note: 60, changed: true });
  assert.equal(envTriggers('gateTrig', false, true), true);
  assert.equal(envTriggers('gateTrig', false, false), false);
  assert.equal(envTriggers('gate', false, true), false); // legato: one envelope
  assert.equal(envTriggers('gate', true, true), true);
  assert.equal(envTriggers('lfo', true, true), false); // the modulator gates it instead
});

test('LFO delay fades the modulation in', () => {
  near(lfoDelayDepth(0, 0), 1);
  near(lfoDelayDepth(0, 1), 0);
  near(lfoDelayDepth(0.5, 1), 0.5);
  near(lfoDelayDepth(3, 1), 1);
});

test('VCO-1 ∿ wave: a rounded triangle, symmetric, peak ±1', () => {
  const w = roundedTriangle(1000);
  near(Math.max(...w), 1, 1e-3);
  near(Math.min(...w), -1, 1e-3);
  near(w[0], 0);
  near(w[100], -w[600], 1e-9);
  // Rounder than a triangle: above it between the zero crossing and the peak.
  assert.ok(w[125] > 0.5);
});

test('NOTE IN / NOTE OUT, AUDIO IN and OUTPUT jacks; 37 keys', () => {
  const ids = SH2_GEAR.jacks.map((j) => j.id);
  for (const id of ['notesIn', 'notesOut', 'in', 'out']) assert.ok(ids.includes(id), id);
  assert.deepEqual(SH2_GEAR.keyboard, { from: -12, keys: 37 });
  for (const d of SH2_GEAR.params) assert.ok(d.default >= d.min && d.default <= d.max, d.id);
});
