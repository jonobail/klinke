// Run with `npm test` (node --test; Node strips the types itself).
// The contract every rack device module must meet (see docs/DEVICES.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVICES } from '../src/app/core/devices/index.ts';
import { GEAR, INVENTORY, defaultParams } from '../src/app/core/gear.ts';

const BRANDS = /eventide|lexicon|sony|yamaha|moog|korg|roland/i;

test('twelve rack devices, each in the catalog and on the shelf once', () => {
  assert.equal(DEVICES.length, 12);
  const kinds = DEVICES.map((d) => d.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const k of kinds) {
    assert.equal(GEAR[k].category, 'rack', k);
    assert.equal(INVENTORY.filter((i) => i === k).length, 1, k);
  }
});

for (const d of DEVICES) {
  test(`${d.kind}: a well-formed rack unit`, () => {
    assert.ok(!BRANDS.test(d.label) && !BRANDS.test(d.subtitle ?? ''), 'model names only');
    assert.ok(d.w >= 6 && d.w <= 18 && d.h >= 3 && d.h <= 5, `size ${d.w}×${d.h}`);
    const jacks = d.jacks.map((j) => j.id);
    assert.ok(jacks.includes('in') && jacks.includes('out'));
    for (const j of d.jacks) assert.ok(j.fx >= 0 && j.fx <= 1 && j.fy >= 0 && j.fy <= 1, j.id);

    const ids = d.params.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'unique params');
    assert.ok(ids.includes('bypass'));
    for (const p of d.params) {
      assert.ok(p.default >= 0 && p.default <= 1, `${p.id} default in 0–1`);
      if (p.steps) {
        assert.ok(p.steps >= 2);
        if (p.options) assert.equal(p.options.length, p.steps, `${p.id} options`);
        const pos = p.default * (p.steps - 1);
        assert.ok(Math.abs(pos - Math.round(pos)) < 1e-9, `${p.id} default on a position`);
      }
    }

    // Every control on the panel exists, and nothing appears twice.
    const placed = (d.sections ?? []).flatMap((s) => [
      ...(s.params ?? []),
      ...(s.rows ?? []).flat().filter((x): x is string => !!x),
    ]);
    for (const id of placed) assert.ok(ids.includes(id), `section control ${id} exists`);
    assert.equal(new Set(placed).size, placed.length, 'no control placed twice');
    // Every param but BYPASS (which has its own button) is reachable on the panel.
    for (const id of ids)
      if (id !== 'bypass') assert.ok(placed.includes(id), `${id} is on the panel`);

    const text = d.display?.(defaultParams(d.kind));
    assert.equal(typeof text, 'string');
    assert.ok(text!.length > 0 && text!.length <= 24, `display "${text}"`);
  });
}
