// Run with `npm test` (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK, VIDEO_ID_RE, upstreamRange } from '../server/lib/range.mjs';

test('relayed ranges start where the browser asks and are capped at one chunk', () => {
  assert.deepEqual(upstreamRange(undefined), { start: 0, end: CHUNK - 1 });
  assert.deepEqual(upstreamRange('bytes=0-'), { start: 0, end: CHUNK - 1 });
  assert.deepEqual(upstreamRange('bytes=500-1499'), { start: 500, end: 1499 });
  assert.deepEqual(upstreamRange('bytes=100-'), { start: 100, end: 100 + CHUNK - 1 });
  assert.equal(upstreamRange('bytes=-500'), null); // suffix ranges aren't supported
  assert.equal(upstreamRange('bytes=10-5'), null);
  assert.equal(upstreamRange('bytes=0-1,5-9'), null);
  assert.equal(upstreamRange('items=0-1'), null);
});

test('only well-formed video IDs reach yt-dlp', () => {
  assert.ok(VIDEO_ID_RE.test('aqz-KE-bpKQ'));
  for (const bad of ['', 'short', 'aqz-KE-bpKQx', '../etc/pass', 'aqz KE bpKQ', '-- --exec x']) {
    assert.ok(!VIDEO_ID_RE.test(bad), bad);
  }
});
