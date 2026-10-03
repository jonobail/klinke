// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CELL,
  FLOOR_H,
  FLOOR_LIMIT,
  FLOOR_W,
  addGear,
  cableAt,
  connect,
  demoPatch,
  disconnect,
  drawnExtent,
  emptyPatch,
  floorExtent,
  moveGear,
  parsePatch,
  freeSpot,
  removeGear,
  setParam,
  setText,
  signalOrder,
} from '../src/app/core/patch.ts';
import type { Patch } from '../src/app/core/patch.ts';
import { GEAR } from '../src/app/core/gear.ts';

const withGear = (...kinds: Parameters<typeof addGear>[1][]): Patch =>
  kinds.reduce((p, k, i) => addGear(p, k, i * 4, 0), emptyPatch());

test('a new patch holds only the fixed MAIN • REC output, which cannot be added again or removed', () => {
  const p = emptyPatch();
  assert.deepEqual(
    p.gear.map((g) => g.kind),
    ['output'],
  );
  assert.equal(addGear(p, 'output', 0, 0), p);
  assert.equal(removeGear(p, 'g0'), p);
});

test('gear snaps to cells and goes anywhere right of and below the origin', () => {
  let p = addGear(emptyPatch(), 'ms20', 40.4, -3);
  const synth = p.gear[1];
  assert.deepEqual([synth.x, synth.y], [40, 0]);
  p = moveGear(p, synth.id, 2.6, 99);
  assert.deepEqual([p.gear[1].x, p.gear[1].y], [3, 99]);
  p = moveGear(p, synth.id, -5, -0.4);
  assert.deepEqual([p.gear[1].x, p.gear[1].y], [0, 0]);
  // Past the old 36 × 20 floor, far out, and absurdly far out (held at the limit).
  p = moveGear(p, synth.id, 60, 33);
  assert.deepEqual([p.gear[1].x, p.gear[1].y], [60, 33]);
  p = moveGear(p, synth.id, 1e9, NaN);
  assert.deepEqual([p.gear[1].x, p.gear[1].y], [FLOOR_LIMIT - GEAR.ms20.w, 0]);
});

test('the floor extent covers the furthest gear, never less than the starting floor', () => {
  assert.deepEqual(floorExtent(emptyPatch()), { w: FLOOR_W, h: FLOOR_H });
  assert.deepEqual(floorExtent(demoPatch()), { w: FLOOR_W, h: FLOOR_H });
  const p = addGear(addGear(emptyPatch(), 'overdrive', 60, 2), 'delay', 3, 40);
  assert.deepEqual(floorExtent(p), { w: 60 + GEAR.overdrive.w, h: 40 + GEAR.delay.h });
});

test('the drawn extent reaches down to the lowest hanging cable', () => {
  // Two boxes side by side, far apart: the cable between them sags well below both.
  let p = addGear(addGear(emptyPatch(), 'ms20', 0, 0), 'overdrive', 100, 0);
  const gearOnly = drawnExtent(p);
  assert.equal(gearOnly.w, (100 + GEAR.overdrive.w) * CELL);
  assert.equal(gearOnly.h, FLOOR_H * CELL);
  p = connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g2', jack: 'in' }).patch;
  assert.equal(p.cables.length, 1);
  const withCable = drawnExtent(p);
  assert.equal(withCable.w, gearOnly.w);
  // A ~3700 px cable hangs ~700 px below its jacks, past the 800 px starting floor.
  assert.ok(withCable.h > gearOnly.h && withCable.h > 700 + CELL, String(withCable.h));
});

test('cables run output → input whichever jack is clicked first', () => {
  const p = withGear('ms20', 'delay'); // g1, g2
  const a = connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g2', jack: 'in' });
  const b = connect(p, { gear: 'g2', jack: 'in' }, { gear: 'g1', jack: 'out' });
  assert.equal(a.error, undefined);
  assert.deepEqual(a.patch.cables[0].from, b.patch.cables[0].from);
  assert.deepEqual(b.patch.cables[0].to, { gear: 'g2', jack: 'in' });
});

test('bad patches are refused with a reason', () => {
  const p = withGear('overdrive', 'delay');
  assert.equal(
    connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g1', jack: 'in' }).error,
    'same-gear',
  );
  assert.equal(
    connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g2', jack: 'out' }).error,
    'direction',
  );
  assert.equal(
    connect(p, { gear: 'g1', jack: 'nope' }, { gear: 'g2', jack: 'in' }).error,
    'unknown-jack',
  );
  const loop = connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g2', jack: 'in' }).patch;
  assert.equal(
    connect(loop, { gear: 'g2', jack: 'out' }, { gear: 'g1', jack: 'in' }).error,
    'cycle',
  );
});

test('a jack holds one cable: replugging pulls the old cable out', () => {
  let p = withGear('ms20', 'overdrive', 'delay'); // g1 g2 g3
  p = connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g2', jack: 'in' }).patch;
  p = connect(p, { gear: 'g1', jack: 'out' }, { gear: 'g3', jack: 'in' }).patch;
  assert.equal(p.cables.length, 1);
  assert.equal(cableAt(p, { gear: 'g2', jack: 'in' }), undefined);
  assert.equal(cableAt(p, { gear: 'g3', jack: 'in' })?.from.gear, 'g1');
  // A refused replug leaves the old cable where it was.
  p = connect(p, { gear: 'g3', jack: 'out' }, { gear: 'g2', jack: 'in' }).patch;
  const r = connect(p, { gear: 'g2', jack: 'out' }, { gear: 'g3', jack: 'in' });
  assert.equal(r.error, 'cycle');
  assert.equal(r.patch, p);
  assert.equal(cableAt(p, { gear: 'g3', jack: 'in' })?.from.gear, 'g1');
});

test('removing gear unplugs its cables', () => {
  let p = demoPatch();
  const delay = p.gear.find((g) => g.kind === 'mf104')!;
  const before = p.cables.length;
  p = removeGear(p, delay.id);
  assert.equal(p.cables.length, before - 2); // reverb → delay and delay → mixer
  assert.ok(p.cables.every((c) => c.from.gear !== delay.id && c.to.gear !== delay.id));
  assert.equal(disconnect(p, p.cables[0].id).cables.length, before - 3);
});

test('signal order puts every source before what it feeds', () => {
  const p = demoPatch();
  const kinds = signalOrder(p).map((id) => p.gear.find((g) => g.id === id)!.kind);
  assert.deepEqual(kinds, ['ms20', 'modelD', 'overdrive', 'reverb', 'mf104', 'mixer', 'output']);
});

test('free spots never overlap gear or the tag row above it', () => {
  let p = demoPatch();
  for (let i = 0; i < 4; i++)
    p = addGear(p, 'filter', freeSpot(p, 'filter').x, freeSpot(p, 'filter').y);
  const boxes = p.gear.map((g) => ({
    x: g.x,
    y: g.y - 1,
    w: GEAR[g.kind].w,
    h: GEAR[g.kind].h + 1,
  }));
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, JSON.stringify([a, b]));
    }
  }
});

test('freeSpot always finds room, growing the floor downward once it is full', () => {
  let p = demoPatch();
  const kinds = ['overdrive', 'ms20', 'mixer', 'delay', 'modelD', 'reverb', 'filter'] as const;
  for (let i = 0; i < 60; i++) {
    const kind = kinds[i % kinds.length];
    const spot = freeSpot(p, kind);
    p = addGear(p, kind, spot.x, spot.y);
    const g = p.gear[p.gear.length - 1];
    assert.deepEqual([g.x, g.y], [spot.x, spot.y]); // not moved by clamping
  }
  assert.equal(p.gear.length, demoPatch().gear.length + 60);
  assert.ok(floorExtent(p).h > FLOOR_H * 3, 'grew past the starting floor');
  const boxes = p.gear.map((g) => ({ x: g.x, y: g.y, w: GEAR[g.kind].w, h: GEAR[g.kind].h }));
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, JSON.stringify([a, b]));
    }
  }
});

test('freeSpot uses the room beside gear placed far to the right', () => {
  let p = emptyPatch();
  p = addGear(p, 'overdrive', 70, 1);
  // The rows are now 76 cells wide; a box fits on the first row, past the output.
  const spot = freeSpot(p, 'ms20');
  assert.equal(spot.y, 1);
});

test('params clamp to 0–1 and selector knobs click to a position', () => {
  const p = setParam(withGear('delay'), 'g1', 'mix', 1.7);
  assert.equal(p.gear[1].params['mix'], 1);
  const ms = withGear('ms20');
  assert.equal(setParam(ms, 'g1', 'vco1Scale', 0.4).gear[1].params['vco1Scale'], 1 / 3);
  assert.equal(setParam(ms, 'g1', 'vco1Scale', 0.55).gear[1].params['vco1Scale'], 2 / 3);
  assert.equal(setParam(ms, 'g1', 'vco1Pw', 0.55).gear[1].params['vco1Pw'], 0.55); // continuous
});

test('patches saved with the old MS-1 load with an MS-20 in its place, cables kept', () => {
  const old = {
    gear: [
      { id: 'g0', kind: 'output', x: 30, y: 4, params: {} },
      { id: 'g1', kind: 'synth', x: 1, y: 1, params: { wave: 0.2 } },
    ],
    cables: [{ id: 'c2', from: { gear: 'g1', jack: 'out' }, to: { gear: 'g0', jack: 'in' } }],
    nextId: 3,
  };
  const p = parsePatch(JSON.stringify(old))!;
  assert.equal(p.gear[1].kind, 'ms20');
  assert.equal(p.gear[1].params['wave'], undefined);
  assert.equal(p.gear[1].params['vco1Wave'], 1 / 3);
  assert.equal(p.cables.length, 1);
});

test('saved gear beyond the old 36 × 20 floor loads where it was', () => {
  const p = addGear(addGear(demoPatch(), 'overdrive', 64, 3), 'delay', 5, 42);
  const back = parsePatch(JSON.stringify(p))!;
  assert.deepEqual(
    back.gear.slice(-2).map((g) => [g.x, g.y]),
    [
      [64, 3],
      [5, 42],
    ],
  );
  // Junk coordinates land at the origin rather than off the floor.
  const odd = JSON.parse(JSON.stringify(p));
  odd.gear[1].x = 'left';
  odd.gear[1].y = -12;
  const fixed = parsePatch(JSON.stringify(odd))!;
  assert.deepEqual([fixed.gear[1].x, fixed.gear[1].y], [0, 0]);
});

test('stored patches round-trip and junk is rejected', () => {
  const p = demoPatch();
  const back = parsePatch(JSON.stringify(p))!;
  assert.deepEqual(back.gear, p.gear);
  assert.deepEqual(
    back.cables.map((c) => [c.from, c.to]),
    p.cables.map((c) => [c.from, c.to]),
  );
  assert.ok(back.nextId >= p.nextId);
  assert.equal(parsePatch('not json'), undefined);
  assert.equal(parsePatch('{"gear":[],"cables":[]}'), undefined); // no output
  const odd = JSON.parse(JSON.stringify(p));
  odd.gear.push({ id: 'zz', kind: 'theremin', x: 0, y: 0 });
  odd.cables.push({ from: { gear: 'zz', jack: 'out' }, to: { gear: 'g0', jack: 'in' } });
  assert.equal(parsePatch(JSON.stringify(odd))!.gear.length, p.gear.length);
});

test('text settings (e.g. the SH-101 sequence) save with the patch, capped and type-checked', () => {
  let p = addGear(emptyPatch(), 'sh101', 1, 1);
  const sh = p.gear[1].id;
  p = setText(p, sh, 'sequence', '[48,null,52]');
  assert.equal(parsePatch(JSON.stringify(p))!.gear[1].text?.['sequence'], '[48,null,52]');
  assert.equal(setText(p, sh, 'sequence', 'x'.repeat(2000)).gear[1].text?.['sequence'].length, 500);
  const junk = JSON.parse(JSON.stringify(p));
  junk.gear[1].text = { sequence: 42, ok: 'yes' };
  assert.deepEqual(parsePatch(JSON.stringify(junk))!.gear[1].text, { ok: 'yes' });
});

test('patches with gear that no longer exists load without it (and its cables)', () => {
  const p = emptyPatch();
  const old = {
    ...p,
    gear: [...p.gear, { id: 'g9', kind: 'deck', x: 1, y: 1, params: {}, text: { link: 'x' } }],
    cables: [{ id: 'c1', from: { gear: 'g9', jack: 'out' }, to: { gear: 'g0', jack: 'in' } }],
  };
  const back = parsePatch(JSON.stringify(old))!;
  assert.deepEqual(
    back.gear.map((g) => g.kind),
    ['output'],
  );
  assert.equal(back.cables.length, 0);
});
