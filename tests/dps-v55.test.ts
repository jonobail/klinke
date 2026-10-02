// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { V55_FXB, dpsV55, v55Settings } from '../src/app/core/devices/dps-v55.ts';
import { V55_FX } from '../src/app/core/devices/dps-fx.ts';

const at = (over: Record<string, number>) => v55Settings({ ...defaultParams('dpsV55'), ...over });
const posA = (no: number) => V55_FX.findIndex((d) => d.no === no) / (V55_FX.length - 1);

test('the default is preset 001 "Super Reverb": FxA 11 / FxB 12 in parallel (manual p.10)', () => {
  const s = at({});
  assert.equal(s.a.no, 11);
  assert.equal(s.b?.no, 12);
  assert.equal(s.serial, false);
  assert.equal(dpsV55.display!(defaultParams('dpsV55')), '11/12 Hall2\nRevT 3.0s');
});

test('FxB takes only 2ch and Mono-Pair effects; a 4ch FxA switches FxB off (p.8)', () => {
  assert.ok(V55_FXB.every((d) => d.no >= 10));
  assert.equal(at({ fxA: posA(2) }).b, undefined);
  assert.equal(at({ fxA: posA(15) }).b?.no, 12);
  assert.equal(at({ fxB: 0 }).b, undefined);
});

test('the structure symbol: "/" parallel, ">" serial', () => {
  assert.equal(dpsV55.display!({ ...defaultParams('dpsV55'), struct: 1 }).slice(0, 5), '11>12');
  assert.equal(dpsV55.display!({ ...defaultParams('dpsV55'), fxB: 0 }).slice(0, 5), '11/--');
  for (let i = 0; i < V55_FX.length; i++) {
    assert.ok(
      dpsV55.display!({ ...defaultParams('dpsV55'), fxA: i / (V55_FX.length - 1) }).length <= 24,
    );
  }
});
