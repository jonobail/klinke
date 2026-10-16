// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHORDS_GEAR,
  DEFAULT_PROGRESSION,
  SCALES,
  arpOrder,
  arpStepMs,
  bounceTimes,
  buildChord,
  chordName,
  chordsSettings,
  diatonicChord,
  formatProgression,
  formatStatus,
  generatePattern,
  generateProgression,
  invert,
  leadFrom,
  motion,
  padForStep,
  parsePattern,
  parseProgression,
  parseStatus,
  rng,
  roman,
  sixteenthMs,
  slideAt,
  snapToScale,
  stepsToNext,
  strumOffsets,
  voice,
} from '../src/app/core/chords.ts';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';

const MAJOR = SCALES[0].steps;
const MINOR = SCALES[1].steps;
const HARM = SCALES.find((s) => s.label === 'HARM MINOR')!.steps;
const at = (over: Record<string, number>) =>
  chordsSettings({ ...defaultParams('chords'), ...over });

test('catalog: a midi-category note effect with NOTE IN and NOTE OUT', () => {
  assert.equal(GEAR.chords, CHORDS_GEAR);
  assert.equal(CHORDS_GEAR.category, 'midi');
  const out = CHORDS_GEAR.jacks.find((j) => j.id === 'notesOut')!;
  assert.equal(out.signal, 'note');
  assert.equal(out.label, 'NOTE OUT');
  assert.equal(CHORDS_GEAR.jacks.find((j) => j.id === 'notesIn')?.signal, 'note');
  assert.equal(CHORDS_GEAR.params.find((d) => d.id === 'dice')?.action, 'dice');
});

test('diatonic chords in C major, named', () => {
  const names = [0, 1, 2, 3, 4, 5, 6].map((d) => chordName(diatonicChord(60, MAJOR, d, 1)));
  assert.deepEqual(names, ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  const sevenths = [0, 1, 2, 3, 4, 5, 6].map((d) => chordName(diatonicChord(60, MAJOR, d, 2)));
  assert.deepEqual(sevenths, ['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5']);
  assert.deepEqual(diatonicChord(60, MAJOR, 4, 2), [67, 71, 74, 77]);
  assert.equal(chordName(diatonicChord(60, MAJOR, 1, 3)), 'Dm9');
  assert.equal(chordName(diatonicChord(60, MAJOR, 4, 4)), 'G11');
  assert.equal(chordName(diatonicChord(60, MAJOR, 3, 4)), 'Fmaj9#11');
  assert.equal(chordName(diatonicChord(60, MAJOR, 2, 3)), 'Em7b9');
});

test('harmonic minor: minor-major 7th, augmented, diminished 7th', () => {
  assert.equal(chordName(diatonicChord(60, HARM, 0, 2)), 'CmMaj7');
  assert.equal(chordName(diatonicChord(60, HARM, 2, 2)), 'Ebmaj7#5');
  assert.equal(chordName(diatonicChord(60, HARM, 6, 2)), 'Bdim7');
  assert.equal(chordName(diatonicChord(60, HARM, 4, 2)), 'G7');
});

test('slash names when the bass is not the root; roman numerals', () => {
  assert.equal(chordName([60, 64, 67], 64), 'C/E');
  assert.equal(chordName([60, 64, 67], 48), 'C');
  assert.deepEqual(
    [0, 1, 6].map((d) => roman(MAJOR, d)),
    ['I', 'ii', 'vii°'],
  );
  assert.equal(roman(MINOR, 2), 'III');
});

test('snap to scale: non-scale keys go to the nearest scale note, ties down', () => {
  assert.deepEqual(snapToScale(64, 0, MAJOR), { note: 64, degree: 37 }); // E, degree 2 (+5 oct)
  assert.equal(snapToScale(61, 0, MAJOR).note, 60); // C# → C (tie goes down)
  assert.equal(snapToScale(66, 0, MAJOR).note, 65); // F# → F
  assert.equal(snapToScale(61, 2, MAJOR).note, 61); // C# is in D major
  assert.equal(((snapToScale(61, 2, MAJOR).degree % 7) + 7) % 7, 6);
});

test('inversions and voicings', () => {
  assert.deepEqual(invert([60, 64, 67], 1), [64, 67, 72]);
  assert.deepEqual(invert([60, 64, 67], 2), [67, 72, 76]);
  assert.deepEqual(voice([60, 64, 67, 71], 'drop2'), [55, 60, 64, 71]);
  assert.deepEqual(voice([60, 64, 67, 71], 'open'), [60, 67, 76, 83]);
  assert.deepEqual(voice([60, 64, 67], 'spread'), [48, 64, 67]);
  assert.deepEqual(voice([60, 64, 67, 71], 'spread'), [48, 64, 71, 79]);
  assert.deepEqual(voice([60, 64, 67], 'close'), [60, 64, 67]);
});

test('voice leading picks the inversion that moves least', () => {
  // C → F: the nearest F is C–F–A (2nd inversion), keeping the common C.
  const f = leadFrom([65, 69, 72], [60, 64, 67], 'close', 64);
  assert.deepEqual(f, [60, 65, 69]);
  assert.ok(motion(f, [60, 64, 67]) < motion([65, 69, 72], [60, 64, 67]));
  // No previous chord: as built.
  assert.deepEqual(leadFrom([65, 69, 72], null, 'close', 64), [65, 69, 72]);
});

test('buildChord: pads around C3 in the key; SCALE mode on the played key', () => {
  const s = at({ lead: 0 });
  assert.deepEqual(buildChord(s, 0, 1, null).notes, [48, 52, 55]);
  assert.equal(buildChord(s, 4, 2, null).name, 'G7');
  // KEY = D: pad I is D major.
  assert.equal(buildChord(at({ lead: 0, key: 2 / 11 }), 0, 1, null).name, 'D');
  // SCALE mode, A (69) in C major: Am rooted on that A; CHORD SIZE forced to 7th.
  const am = buildChord(at({ lead: 0, size: 0.5 }), 5, 1, null, 69);
  assert.deepEqual(am.notes, [69, 72, 76, 79]);
  assert.equal(am.name, 'Am7');
  // OCTAVE +1 lifts it.
  assert.equal(buildChord(at({ lead: 0, octave: 0.75 }), 0, 1, null).notes[0], 60);
  // INVERSION 1st puts the third in the bass.
  assert.equal(buildChord(at({ lead: 0, inversion: 1 / 3 }), 0, 1, null).name, 'C/E');
});

test('voice leading keeps a long progression in range', () => {
  const s = at({});
  let prev: number[] | null = null;
  for (let i = 0; i < 40; i++) {
    const d = DEFAULT_PROGRESSION[i % 8];
    prev = buildChord(s, d.degree, d.size, prev).notes;
    assert.ok(prev[0] >= 40 && prev[prev.length - 1] <= 72, `${prev}`);
  }
});

test('PADS mode: white keys from the base C are pads 1–8, black keys play nothing', () => {
  assert.deepEqual([0, 2, 4, 5, 7, 9, 11, 12].map(padForStep), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(padForStep(1), null);
  assert.equal(padForStep(14), 0); // wraps
  assert.equal(padForStep(-1), 7); // B below the base C: the white key before pad 1 is pad 8
});

test('progressions: stored as text, seeded generation is repeatable and loops', () => {
  const text = formatProgression(DEFAULT_PROGRESSION);
  assert.equal(text, '0:1 5:1 3:1 4:1 1:2 4:2 0:2 3:2');
  assert.deepEqual(parseProgression(text), DEFAULT_PROGRESSION);
  assert.equal(parseProgression('0:1 2:1'), null);
  assert.equal(parseProgression(undefined), null);
  for (let style = 0; style < 5; style++) {
    const a = generateProgression(style, rng(7));
    assert.deepEqual(a, generateProgression(style, rng(7)));
    assert.equal(a.length, 8);
    for (const d of a) {
      assert.ok(d.degree >= 0 && d.degree < 7);
      assert.ok(d.size >= 1 && d.size <= 4);
    }
  }
});

test('styles sound like themselves', () => {
  let ii = 0;
  let iiV = 0;
  let triads = 0;
  for (let seed = 0; seed < 200; seed++) {
    const jazz = generateProgression(1, rng(seed));
    for (let i = 0; i < 7; i++) {
      if (jazz[i].degree === 1) {
        ii++;
        if (jazz[i + 1].degree === 4) iiV++;
      }
    }
    triads += generateProgression(0, rng(seed)).filter((d) => d.size === 1).length;
    // BOSSA: no plain triads.
    assert.ok(generateProgression(2, rng(seed)).every((d) => d.size > 1));
  }
  assert.ok(iiV / ii > 0.8, `ii→V ${iiV}/${ii}`);
  assert.ok(triads / 1600 > 0.6, 'POP is mostly triads');
});

test('patterns: presets parse to 16 steps; GEN always hits beat 1', () => {
  const p = parsePattern('x...o...x...o...');
  assert.equal(p.length, 16);
  assert.deepEqual([p[0], p[1], p[4]], [1, 0, 0.72]);
  assert.equal(stepsToNext(p, 0), 4);
  assert.equal(stepsToNext(p, 12), 4); // wraps to the next bar
  for (let s = 0; s < 5; s++) {
    const g = generatePattern(s, rng(3));
    assert.equal(g.length, 16);
    assert.equal(g[0], 'x');
    assert.match(g, /^[xo.]+$/);
  }
});

test('strum: up, down, alternate', () => {
  assert.deepEqual(strumOffsets(3, 10, 0), [0, 10, 20]);
  assert.deepEqual(strumOffsets(3, 10, 1), [20, 10, 0]);
  assert.deepEqual(strumOffsets(3, 10, 2, 0), [0, 10, 20]);
  assert.deepEqual(strumOffsets(3, 10, 2, 1), [20, 10, 0]);
});

test('arp orders', () => {
  const c = [64, 60, 67];
  assert.deepEqual(arpOrder(c, 'up', 1), [[60], [64], [67]]);
  assert.deepEqual(arpOrder(c, 'down', 1), [[67], [64], [60]]);
  assert.deepEqual(arpOrder(c, 'updown', 1), [[60], [64], [67], [64]]);
  assert.deepEqual(arpOrder(c, 'up', 2).flat(), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(arpOrder(c, 'chord', 2), [
    [60, 64, 67],
    [72, 76, 79],
  ]);
});

test('tempo-synced rates', () => {
  assert.equal(arpStepMs(0, 120), 500); // 1/4
  assert.equal(arpStepMs(3, 120), 125); // 1/16
  assert.ok(Math.abs(arpStepMs(2, 120) - 500 / 3) < 1e-9); // 1/8T
  assert.equal(sixteenthMs(120), 125);
});

test('bounce: repeats come sooner and softer', () => {
  const b = bounceTimes(6, 300);
  assert.equal(b.length, 6);
  assert.equal(b[0].at, 300);
  for (let i = 1; i < b.length; i++) {
    assert.ok(b[i].at - b[i - 1].at < (i > 1 ? b[i - 1].at - b[i - 2].at : 300));
    assert.ok(b[i].level < b[i - 1].level);
  }
  assert.equal(bounceTimes(0, 300).length, 0);
  assert.ok(bounceTimes(12, 60).length < 12); // stops once the gaps get too short
});

test('bend: slides from the offset to the note', () => {
  assert.equal(slideAt(0, -2, 100), -2);
  assert.ok(Math.abs(slideAt(50, -2, 100) + 0.5) < 1e-9);
  assert.equal(slideAt(100, -2, 100), 0);
  assert.equal(slideAt(500, 3, 100), 0);
  assert.equal(at({}).bend, 0); // centre is off
  assert.equal(at({ bend: 1 }).bend, 12);
  assert.equal(at({ bend: 0.25 }).bend, -6);
});

test('status line round-trips', () => {
  const st = { chord: 'Dm7/C', lit: [0, 3], rec: 2 };
  assert.deepEqual(parseStatus(formatStatus(st)), st);
  assert.deepEqual(parseStatus(undefined), { chord: '', lit: [], rec: -1 });
});
