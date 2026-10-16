// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  Allocator,
  GRID,
  MAX_SINGERS,
  STYLE_DEFS,
  VOWELS,
  choirSettings,
  choirStatus,
  formants,
  glottalFlow,
  glottalPulse,
  glottalShape,
  gridLookup,
  noseDiameters,
  noseSections,
  parseChoirStatus,
  singers,
  tractDiameters,
  tractSections,
  velumIndex,
  vowelAt,
  vowelGrid,
  vowelMotion,
} from '../src/app/core/choir.ts';
import { GEAR, defaultParams } from '../src/app/core/gear.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number> = {}) =>
  choirSettings({ ...defaultParams('choir'), ...over });
const vowel = (s: string) => VOWELS.find((v) => v.symbol === s)!;
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

/** The worklet's code, run in a sandbox without registering the processor. */
function worklet() {
  const ctx = vm.createContext({ sampleRate: 48000 });
  return vm.runInContext(
    read('public/worklets/choir.js') +
      '\n;({ glottalPulse, glottalFlow, tractDiameters, noseDiameters, gridLookup, vowelMotion, ChoirProcessor })',
    ctx,
  );
}

test('catalog: well-formed, NOTE IN left and OUT right, every control on the panel', () => {
  const d = GEAR.choir;
  assert.equal(d.category, 'synth');
  assert.ok(d.w === 18 && d.h === 9);
  const notes = d.jacks.find((j) => j.id === 'notesIn')!;
  assert.equal(notes.signal, 'note');
  assert.ok(notes.fx < 0.1 && d.jacks.find((j) => j.id === 'out')!.fx > 0.9);
  const ids = d.params.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const html = read('src/app/gear/choir-panel.html');
  for (const p of d.params) {
    assert.ok(p.default >= 0 && p.default <= 1, p.id);
    if (p.steps) {
      const pos = p.default * (p.steps - 1);
      assert.ok(Math.abs(pos - Math.round(pos)) < 1e-9, `${p.id} default on a position`);
    }
    // vowelX / vowelY are set by the chart.
    if (!p.id.startsWith('vowel')) assert.ok(html.includes(`'${p.id}'`), `${p.id} on the panel`);
  }
});

test('no commercial product names in the CHOIR-16 files', () => {
  const banned = /human\s*ist|mpe\s*motion|chord\s*imist|leestrument/i;
  for (const f of [
    'src/app/core/choir.ts',
    'src/app/audio/choir-unit.ts',
    'public/worklets/choir.js',
    'src/app/gear/choir-panel.ts',
    'src/app/gear/choir-panel.html',
    'docs/devices/choir.md',
  ])
    assert.ok(!banned.test(read(f)), f);
});

test('vowel chart: exact on the anchors, the grid agrees with it', () => {
  for (const v of VOWELS) {
    const a = vowelAt(v.x, v.y);
    near(a.tongue, v.tongue);
    near(a.lips, v.lips);
  }
  const g = vowelGrid();
  for (const [x, y] of [
    [0, 0],
    [0.5, 0.25],
    [1, 1],
    [0.25, 0.75],
  ]) {
    const a = gridLookup(g, GRID, x, y);
    near(a.tongue, vowelAt(x, y).tongue, 1e-5);
  }
  // Between grid points it interpolates: close to the true value.
  const mid = gridLookup(g, GRID, 0.47, 0.61);
  near(mid.height, vowelAt(0.47, 0.61).height, 0.05);
});

test('tract length: one section per sample of travel, child < woman < man', () => {
  assert.equal(tractSections(17, 48000), 23);
  assert.equal(tractSections(17, 44100), 21);
  const s = at({ type: 0 });
  const kid = singers(s)[0].length;
  const woman = singers(at({ type: 1 / 3 }))[0].length;
  const man = singers(at({ type: 2 / 3 }))[0].length;
  assert.ok(kid < woman && woman < man, `${kid} ${woman} ${man}`);
  assert.ok(singers(at({ neck: 1 }))[0].length > singers(at({ neck: 0 }))[0].length);
  assert.ok(velumIndex(23) > 5 && velumIndex(23) < 18);
  assert.equal(noseSections(23), 14);
});

test('tract resonances: /a/ opens F1, /i/ raises F2, /u/ lowers it, a child is higher', () => {
  const fs = 48000;
  const n = tractSections(17, fs);
  const [a1, a2] = formants(tractDiameters(n, vowel('a')), fs);
  const [i1, i2] = formants(tractDiameters(n, vowel('i')), fs);
  const [u1, u2] = formants(tractDiameters(n, vowel('u')), fs);
  const [s1] = formants(tractDiameters(n, vowel('ə')), fs);
  assert.ok(a1 > i1 + 250 && a1 > u1 + 250, `F1 a ${a1} i ${i1} u ${u1}`);
  assert.ok(i2 > a2 + 600, `F2 i ${i2} a ${a2}`);
  assert.ok(u2 < a2 && u2 < 1100, `F2 u ${u2}`);
  // A uniform 17 cm tube: the first resonance near c / 4L ≈ 500 Hz.
  assert.ok(s1 > 400 && s1 < 650, `schwa F1 ${s1}`);
  const child = tractSections(11, fs);
  const [c1] = formants(tractDiameters(child, vowel('a')), fs);
  assert.ok(c1 > a1 * 1.3, `child F1 ${c1}`);
});

test('glottal pulse: opens, snaps shut, stays closed; tenseness shortens the open phase', () => {
  const { oq, skew } = glottalShape(0.6);
  assert.equal(glottalPulse(oq + 0.01, oq, skew), 0);
  assert.equal(glottalFlow(0, oq, skew), 0);
  near(glottalFlow(oq * skew, oq, skew), 1);
  // The flow derivative integrates back to zero over the cycle (the folds end where they began).
  let sum = 0;
  let min = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const v = glottalPulse(i / N, oq, skew);
    sum += v / N;
    min = Math.min(min, v);
  }
  near(sum, 0, 1e-3);
  assert.ok(min < -0.8 && min > -2, `closing peak ${min}`);
  assert.ok(glottalShape(1).oq < glottalShape(0).oq);
});

test('worklet DSP mirrors the reference maths', () => {
  const w = worklet();
  const rnd = (() => {
    let s = 7;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  })();
  for (let k = 0; k < 50; k++) {
    const ph = rnd();
    const { oq, skew } = glottalShape(rnd());
    near(w.glottalPulse(ph, oq, skew), glottalPulse(ph, oq, skew), 1e-12);
    near(w.glottalFlow(ph, oq, skew), glottalFlow(ph, oq, skew), 1e-12);
    const a = vowelAt(rnd(), rnd());
    const shape = { jaw: 0.8 + 0.4 * rnd(), lips: 0.4 + 1.2 * rnd(), pharynx: 0.9 + 0.2 * rnd() };
    const n = 12 + Math.floor(rnd() * 20);
    const ref = tractDiameters(n, a, shape);
    const got = w.tractDiameters(
      n,
      a.tongue,
      a.height,
      a.lips,
      a.jaw,
      shape.jaw,
      shape.lips,
      shape.pharynx,
      new Float64Array(n),
    );
    for (let i = 0; i < n; i++) near(got[i], ref[i], 1e-12);
    const nose = noseDiameters(14, 0.2, 1.1);
    const wn = w.noseDiameters(14, 0.2, 1.1, new Float64Array(14));
    for (let j = 0; j < 14; j++) near(wn[j], nose[j], 1e-12);
    const [x, y] = [rnd(), rnd()];
    const g = vowelGrid();
    const ga = gridLookup(g, GRID, x, y);
    const wg = w.gridLookup(g, GRID, x, y, new Float64Array(4));
    near(wg[0], ga.tongue, 1e-6);
    near(wg[3], ga.jaw, 1e-6);
    for (let mode = 0; mode < 6; mode++) {
      const args = [rnd() * 7, rnd(), rnd(), 0.3, rnd() * 2 - 1, rnd() * 2 - 1, x, y] as const;
      const ref2 = vowelMotion(mode, ...args);
      const got2 = w.vowelMotion(mode, ...args, new Float64Array(2));
      near(got2[0], ref2[0], 1e-12);
      near(got2[1], ref2[1], 1e-12);
    }
  }
});

test('worklet renders: a sung note sounds, stays finite, and its singer goes idle after release', () => {
  const w = worklet();
  const p = new w.ChoirProcessor();
  const s = at();
  p.message({ type: 'grid', grid: vowelGrid(), size: GRID });
  p.message({
    type: 'singers',
    list: singers(s).map((c) => {
      const n = tractSections(c.length, 48000);
      return {
        n,
        m: noseSections(n),
        v: velumIndex(n),
        jaw: 1,
        lips: 1,
        pharynx: 1,
        noseSize: 1,
        pan: c.pan,
        detune: 0,
        vibRate: 1,
        vibDepth: 1,
        breath: 1,
        jitter: 1,
        tense: 0,
        lag: 0,
      };
    }),
  });
  p.message({ type: 'params', params: { attack: 0.02, release: 0.05 } });
  p.message({ type: 'on', s: 3, note: 57, vel: 0.8, pressure: 0.8, timbre: 0.5, legato: false });
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  let peak = 0;
  for (let b = 0; b < 260; b++) {
    if (b === 100) p.message({ type: 'off', s: 3 });
    p.process([], [[l, r]]);
    for (let i = 0; i < 128; i++) {
      assert.ok(Number.isFinite(l[i]) && Number.isFinite(r[i]));
      if (b < 100) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    }
  }
  assert.ok(peak > 0.005 && peak < 2, `peak ${peak}`);
  assert.equal(p.singers[3].active, false);
  assert.ok(l.every((v: number) => v === 0));
});

test('styles: the knobs at half are the style as it is', () => {
  const s = at({ style: 0, breath: 0.5, rasp: 0.5, vibrato: 0.5 });
  near(s.breath, STYLE_DEFS.classical.breath);
  near(s.vibDepth, STYLE_DEFS.classical.vibDepth);
  assert.equal(at({ vibrato: 0 }).vibDepth, 0);
  assert.ok(at({ style: 1 }).rasp > at({ style: 0.25 }).rasp, 'ROUGH is the raspiest');
  assert.equal(at({ singers: 1 }).singers, MAX_SINGERS);
  assert.equal(at({ singers: 0 }).singers, 1);
});

test('singers: seeded, varied, MIXED alternates women and men', () => {
  const a = singers(at({ type: 1 }));
  const b = singers(at({ type: 1 }));
  assert.deepEqual(a, b);
  assert.equal(a[0].type, 'woman');
  assert.equal(a[1].type, 'man');
  assert.ok(new Set(a.map((s) => s.detune.toFixed(4))).size > 10, 'no two singers alike');
  assert.ok(a[0].pan < 0 && a[MAX_SINGERS - 1].pan > 0);
});

test('CHOIR: each note to the next singer, oldest stolen when all are busy', () => {
  const cast = singers(at({ type: 1 / 3 })).slice(0, 3); // three women
  const al = new Allocator();
  const seats = [60, 64, 67].map((n, v) => al.on(v, n, 'choir', cast, false)[0].singer);
  assert.deepEqual(seats, [0, 1, 2]);
  assert.deepEqual(al.on(9, 72, 'choir', cast, false)[0].singer, 0, 'steals the oldest');
  assert.deepEqual(al.off(0, 'choir', cast, false).release, [], 'its old voice is gone');
  assert.deepEqual(al.off(1, 'choir', cast, false).release, [1]);
  assert.deepEqual(al.singersOf(9), [0]);
  assert.deepEqual(al.off(42, 'choir', cast, false), { release: [], back: [] });
});

test('CHOIR with MIXED: a low note goes to a man', () => {
  const cast = singers(at({ type: 1 })).slice(0, 4);
  const al = new Allocator();
  const [a] = al.on(1, 40, 'choir', cast, false);
  assert.equal(cast[a.singer].type, 'man');
});

test('TUTTI: one key sings in every singer, in their own octaves, within their range', () => {
  const cast = singers(at({ type: 1 })).slice(0, 8);
  const al = new Allocator();
  const as = al.on(1, 60, 'tutti', cast, true);
  assert.equal(as.length, 8);
  const notes = new Set(as.map((a) => a.note));
  assert.ok(notes.size >= 2, 'more than one octave');
  for (const a of as) {
    assert.equal(Math.abs((a.note - 60) % 12), 0);
    assert.ok(Math.abs(a.note - cast[a.singer].centre) <= 14);
  }
  // A second key glides the whole choir; letting go returns to the first.
  const next = al.on(2, 62, 'tutti', cast, true);
  assert.ok(next.every((a) => a.legato));
  const { release, back } = al.off(2, 'tutti', cast, true);
  assert.deepEqual(release, []);
  assert.ok(back.length === 8 && back.every((a) => a.voice === 1 && a.legato));
  assert.equal(al.off(1, 'tutti', cast, true).release.length, 8);
});

test('SOLO: one singer, legato glides only while a note is held', () => {
  const cast = singers(at()).slice(0, 4);
  const al = new Allocator();
  const [first] = al.on(1, 60, 'solo', cast, true);
  assert.equal(first.singer, 0);
  assert.equal(first.legato, false);
  const [tied] = al.on(2, 64, 'solo', cast, true);
  assert.equal(tied.legato, true);
  assert.deepEqual(al.off(1, 'solo', cast, true), { release: [], back: [] }, 'not the top note');
  assert.deepEqual(al.off(2, 'solo', cast, true).release, [0]);
  const [plain] = al.on(3, 60, 'solo', cast, false);
  assert.equal(plain.legato, false);
});

test('status line round-trips', () => {
  const s = { mask: 0b1011, x: 0.25, y: 0.875, level: 0.5 };
  assert.deepEqual(parseChoirStatus(choirStatus(s)), s);
  assert.equal(parseChoirStatus(undefined), null);
  assert.equal(parseChoirStatus('nonsense'), null);
});
