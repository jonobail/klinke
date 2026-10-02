// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import {
  FILTER_HZ,
  HEADROOM,
  bbdClock,
  mf104Settings,
  sallenKey,
  softClipCurve,
} from '../src/app/core/mf104.ts';
import { addGear, connect, emptyPatch, signalOrder } from '../src/app/core/patch.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => mf104Settings({ ...defaultParams('mf104'), ...over });

test('filter corners come from the schematic part values', () => {
  near(sallenKey(10e3, 10e3, 10e-9, 10e-9), 1591.55, 0.01); // textbook check
  assert.ok(FILTER_HZ.short > 2600 && FILTER_HZ.short < 2900, String(FILTER_HZ.short));
  assert.ok(FILTER_HZ.long > 1200 && FILTER_HZ.long < 1350, String(FILTER_HZ.long));
});

test('RANGE LONG doubles every delay time and lowers the filter', () => {
  for (const t of [0, 0.3, 1]) {
    near(at({ time: t, range: 1 }).seconds, 2 * at({ time: t, range: 0 }).seconds);
  }
  near(at({ time: 0 }).seconds, 0.04);
  near(at({ time: 1, range: 1 }).seconds, 0.8);
  assert.equal(at({ range: 1 }).filterHz, FILTER_HZ.long);
});

test('the BBD clock stays above twice the filter corner across each range', () => {
  for (const range of [0, 1]) {
    const s = at({ time: 1, range });
    assert.ok(bbdClock(s.seconds) / 2 > s.filterHz, `range ${range}`);
  }
  near(bbdClock(0.04), 102400);
});

test('feedback passes unity at the top of the knob; mix is equal-power', () => {
  assert.ok(at({ feedback: 1 }).feedback > 1);
  assert.ok(at({ feedback: 0.9 }).feedback < 1);
  const s = at({ mix: 0.5 });
  near(s.dry * s.dry + s.wet * s.wet, 1);
  near(at({ output: 0.7 }).output, 1);
});

test('the external loop may close a cycle through another pedal: LOOP IN feeds the delay line', () => {
  let p = addGear(addGear(emptyPatch(), 'mf104', 1, 1), 'filter', 10, 1); // g1 MF-104, g2 filter
  p = connect(p, { gear: 'g1', jack: 'loopOut' }, { gear: 'g2', jack: 'in' }).patch;
  const r = connect(p, { gear: 'g2', jack: 'out' }, { gear: 'g1', jack: 'loopIn' });
  assert.equal(r.error, undefined);
  assert.equal(r.patch.cables.length, 2);
  // An ordinary jack still refuses the loop.
  assert.equal(connect(p, { gear: 'g2', jack: 'out' }, { gear: 'g1', jack: 'in' }).error, 'cycle');
  // And the graph still has an order (the return cable doesn't count as a dependency).
  assert.equal(signalOrder(r.patch).length, 3);
});

test('loop saturation has unity gain for small signals and limits big ones to ±1', () => {
  const c = softClipCurve(2049);
  // Curve index i ↔ input HEADROOM × (2i/(n-1) − 1); slope at the centre is 1 in real units.
  const step = (2 * HEADROOM) / 2048;
  near((c[1025] - c[1023]) / (2 * step), 1, 1e-3);
  near(c[1024], 0);
  assert.ok(c[2048] > 0.99 && c[2048] <= 1);
});
