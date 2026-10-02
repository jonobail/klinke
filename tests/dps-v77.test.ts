// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { V77_FX, V77_STRUCTS, dpsV77, v77Settings } from '../src/app/core/devices/dps-v77.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => v77Settings({ ...defaultParams('dpsV77'), ...over });

test('structures SERI 1, SERI 2, PARA, DUAL (pp.8–9)', () => {
  assert.deepEqual([...V77_STRUCTS], ['SERI 1', 'SERI 2', 'PARA', 'DUAL']);
  assert.equal(at({ struct: 1 }).structure, 3);
});

test('the default is the manual’s example: a flanger into a hall (p.8)', () => {
  const s = at({});
  assert.equal(s.a.fx.code, 'StFLN');
  assert.equal(s.b.fx.code, 'Hall2');
  assert.equal(dpsV77.display!(defaultParams('dpsV77')), 'Flang>Hall\nRate 30');
});

test('EQ blocks: OFF / PRE / POST, shelves ±12 dB; mixer levels are unity at 3/4', () => {
  const s = at({ aEq: 0.5, aLow: 1, aHigh: 0 });
  assert.equal(s.a.eq, 'PRE');
  near(s.a.lowDb, 12);
  near(s.a.highDb, -12);
  near(at({ lvlA: 0.75 }).fxA, 1);
  near(at({ dry: 0 }).dry, 0);
});

test('every FX type resolves, with a short display name', () => {
  assert.equal(new Set(V77_FX.map((d) => d.code)).size, V77_FX.length);
  for (const d of V77_FX) assert.ok(d.engine && d.short.length <= 5, d.code);
  for (let i = 0; i < V77_FX.length; i++) {
    for (let j = 0; j < 4; j++) {
      const text = dpsV77.display!({
        ...defaultParams('dpsV77'),
        aType: i / (V77_FX.length - 1),
        struct: j / 3,
      });
      assert.ok(text.length <= 24, text);
    }
  }
});
