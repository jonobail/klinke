// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParams } from '../src/app/core/gear.ts';
import { M7_ALGOS, M7_PRE, dpsM7, m7Settings } from '../src/app/core/devices/dps-m7.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (over: Record<string, number>) => m7Settings({ ...defaultParams('dpsM7'), ...over });

test('modulation block: Algorithm 0 plus the twenty of the table of contents (p.4)', () => {
  assert.equal(M7_ALGOS.length, 21);
  assert.equal(M7_ALGOS[0].code, 'OFF');
  assert.equal(M7_ALGOS[11].code, 'SFL');
  assert.equal(M7_ALGOS[20].code, 'RTY');
  assert.deepEqual([...M7_PRE], ['OFF', 'SEQ', 'SXE', 'DEX', 'GTE', 'CMP']);
});

test('ranges from the parameter tables', () => {
  near(at({ rate: 0 }).rateHz, 0.01); // LFO frequency 0.01–40 Hz
  near(at({ rate: 1 }).rateHz, 40);
  near(at({ rate: 0 }).oscHz, 0.05); // ring modulator OSC 0.05–3000 Hz
  near(at({ rate: 1 }).oscHz, 3000);
  near(at({ algo: 2 / 20, delay: 1 }).delay, 1.0); // Deca chorus predelay to 1000 ms
  near(at({ algo: 13 / 20, delay: 1 }).delay, 0.5); // modulation delay main to 500 ms
  assert.equal(at({ pitch: 1 }).pitch, 2400);
  assert.equal(at({ phase: 1 }).phase, 359);
  assert.ok(Math.abs(at({ feedback: 1 }).feedback) < 1, 'feedback stays below 100 %');
});

test('rotary speed: RATE below half is slow, above is fast', () => {
  assert.equal(at({ rate: 0.2 }).fast, false);
  assert.equal(at({ rate: 0.8 }).fast, true);
});

test('display shows the algorithm and its key value', () => {
  assert.equal(dpsM7.display!(defaultParams('dpsM7')), '01 SCH\n0.42Hz D40');
  assert.equal(dpsM7.display!({ ...defaultParams('dpsM7'), algo: 1, rate: 1 }), '20 RTY\nFAST');
  assert.equal(
    dpsM7.display!({ ...defaultParams('dpsM7'), algo: 5 / 20, pitch: 0.75 }),
    '05 SPS\n+1200c',
  );
  for (let i = 0; i <= 20; i++)
    assert.ok(dpsM7.display!({ ...defaultParams('dpsM7'), algo: i / 20 }).length <= 24);
});
