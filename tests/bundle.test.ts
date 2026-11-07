// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleName, decodeBundle, encodeBundle } from '../src/app/core/bundle.ts';

const project = { name: 'Song', patch: { gear: [], cables: [] }, song: { bpm: 97 } };

test('a bundle round-trips the project and every take, sample for sample', () => {
  const audio = new Map([
    [
      'k1',
      { sampleRate: 48000, channels: [Float32Array.of(0, 0.5, -1), Float32Array.of(1, 0, 0.25)] },
    ],
    ['k2', { sampleRate: 44100, channels: [Float32Array.of(0.125)] }],
  ]);
  const bytes = encodeBundle({ project, audio });
  const back = decodeBundle(bytes)!;
  assert.deepEqual(back.project, project);
  assert.deepEqual([...back.audio.keys()], ['k1', 'k2']);
  assert.equal(back.audio.get('k1')!.sampleRate, 48000);
  assert.deepEqual(Array.from(back.audio.get('k1')!.channels[1]), [1, 0, 0.25]);
  assert.deepEqual(Array.from(back.audio.get('k2')!.channels[0]), [0.125]);
});

test('a bundle with no audio is just the header and JSON', () => {
  const bytes = encodeBundle({ project, audio: new Map() });
  assert.equal(decodeBundle(bytes)!.audio.size, 0);
});

test('a bundle read from part of a larger buffer still decodes', () => {
  const bytes = encodeBundle({ project, audio: new Map() });
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes, 3);
  assert.deepEqual(decodeBundle(padded.subarray(3))!.project, project);
});

test('anything else is refused: wrong magic, truncation, bad JSON or audio entries', () => {
  const good = encodeBundle({
    project,
    audio: new Map([['k', { sampleRate: 48000, channels: [new Float32Array(10)] }]]),
  });
  assert.equal(decodeBundle(new TextEncoder().encode('{"gear":[]}')), undefined);
  assert.equal(decodeBundle(good.subarray(0, good.length - 4)), undefined);
  assert.equal(decodeBundle(good.subarray(0, 10)), undefined);
  const badJson = good.slice();
  badJson[12] = 0x7b; // the opening brace becomes something else below
  badJson[13] = 0x7b;
  assert.equal(decodeBundle(badJson), undefined);
  const head = new TextEncoder().encode(
    JSON.stringify({ project, audio: [{ id: 'k', sampleRate: 48000, frames: 1, channels: 99 }] }),
  );
  const bad = new Uint8Array(12 + head.length + 1000);
  bad.set(good.subarray(0, 8));
  new DataView(bad.buffer).setUint32(8, head.length, true);
  bad.set(head, 12);
  assert.equal(decodeBundle(bad), undefined);
});

test('bundle file names are safe and end in .klinke', () => {
  assert.equal(bundleName('My Song #2!'), 'my-song-2.klinke');
  assert.equal(bundleName('   '), 'klinke-project.klinke');
});
