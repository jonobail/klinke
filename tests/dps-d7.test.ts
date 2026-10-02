// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { D7_ALGOS, d7Settings, dpsD7 } from '../src/app/core/devices/dps-d7.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => d7Settings({ ...defaultParams('dpsD7'), ...over });
const algo = (code: string) => D7_ALGOS.findIndex((a) => a.code === code) / (D7_ALGOS.length - 1);

test('seven delay algorithms, in the manual order (pp.15–20)', () => {
  assert.deepEqual(
    D7_ALGOS.map((a) => a.code),
    ['STD', 'FBD', 'DBD', 'TPD', 'LGD', 'PTD', 'MTD'],
  );
  assert.deepEqual(
    D7_ALGOS.map((a) => a.feedback),
    [false, true, true, false, true, true, true],
  );
});

test('TIME reaches each algorithm’s longest delay', () => {
  near(at({ algo: algo('STD'), time: 1 }).time, 1.36531);
  near(at({ algo: algo('STD'), time: 0 }).time, 0);
  near(at({ algo: algo('FBD'), time: 0 }).time, 0.000021);
  near(at({ algo: algo('DBD'), time: 1, time2: 1 }).time2, 0.68244);
  near(at({ algo: algo('TPD'), time: 1, time2: 1 }).time2, 0.09998);
  near(at({ algo: algo('LGD'), time: 1 }).time, 2.73044);
  near(at({ algo: algo('MTD'), time2: 1 }).time2, 0.68265);
});

test('FEEDBK: right of centre is normal phase, left is inverse; EQ ±12 dB', () => {
  near(at({ feedback: 1 }).feedback, 1);
  near(at({ feedback: 0 }).feedback, -1);
  near(at({ feedback: 0.5 }).feedback, 0);
  near(at({ bass: 1 }).bassDb, 12);
  near(at({ treble: 0 }).trebleDb, -12);
});

test('auto panner: OFF or one of four waves, 0.1–20 Hz (p.21)', () => {
  assert.equal(at({ pan: 0 }).panWave, -1);
  assert.equal(at({ pan: 1 }).panWave, 3);
  near(at({ panRate: 0 }).panHz, 0.1);
  near(at({ panRate: 1 }).panHz, 20);
});

test('display: algorithm and times', () => {
  assert.equal(dpsD7.display!(defaultParams('dpsD7')), '2 FBD 413ms\nR167 FB+40');
  assert.equal(dpsD7.display!({ ...defaultParams('dpsD7'), algo: 0 }), '1 STD 413ms\nR 167ms');
  for (let i = 0; i < D7_ALGOS.length; i++) {
    const text = dpsD7.display!({
      ...defaultParams('dpsD7'),
      algo: i / 6,
      time: 1,
      time2: 1,
      feedback: 1,
    });
    assert.ok(text.length <= 24, text);
  }
});
