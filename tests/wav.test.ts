// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeWav, joinChunks, peaks, trimStart } from '../src/app/core/wav.ts';

test('chunks join per channel; a mono chunk fills both channels', () => {
  const joined = joinChunks(
    [[Float32Array.of(1, 2), Float32Array.of(3, 4)], [Float32Array.of(5)]],
    2,
  );
  assert.deepEqual(Array.from(joined[0]), [1, 2, 5]);
  assert.deepEqual(Array.from(joined[1]), [3, 4, 5]);
});

test('WAV: header, 16-bit interleaved samples, clipping', () => {
  const wav = new DataView(encodeWav([Float32Array.of(0, 1, -1.5), Float32Array.of(0.5, 0, 0)], 48000));
  const str = (at: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(at + i)));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(wav.getUint16(22, true), 2); // channels
  assert.equal(wav.getUint32(24, true), 48000);
  assert.equal(wav.getUint32(40, true), 3 * 2 * 2); // data bytes
  assert.equal(wav.byteLength, 44 + 12);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => wav.getInt16(44 + i * 2, true)),
    [0, 16383, 32767, 0, -32768, 0],
  );
});

test('peaks: one value per slice, the loudest sample on either channel', () => {
  const left = Float32Array.from({ length: 100 }, (_, i) => (i < 50 ? 0.1 : -0.8));
  const right = Float32Array.from({ length: 100 }, (_, i) => (i === 10 ? 0.5 : 0));
  assert.deepEqual(peaks([left, right], 100, 2), [0.5, 0.8]);
  assert.deepEqual(peaks([], 100), []);
});

test('trimming the start lines a take up', () => {
  assert.deepEqual(Array.from(trimStart([Float32Array.of(1, 2, 3)], 2)[0]), [3]);
  assert.deepEqual(Array.from(trimStart([Float32Array.of(1, 2, 3)], -4)[0]), [1, 2, 3]);
});
