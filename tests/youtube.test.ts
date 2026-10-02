// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, startTime, videoId } from '../src/app/core/youtube.ts';
import { addGear, emptyPatch, parsePatch, setText } from '../src/app/core/patch.ts';

const ID = 'aqz-KE-bpKQ';

test('video IDs from every common link form', () => {
  for (const link of [
    ID,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?app=desktop&v=${ID}&list=PL123&index=2`,
    `youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}&t=42s`,
    `https://youtu.be/${ID}?si=abcdef`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=10`,
    `https://music.youtube.com/watch?v=${ID}&feature=share`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `  https://youtu.be/${ID}  `,
  ]) {
    assert.equal(videoId(link), ID, link);
  }
});

test('anything else is rejected', () => {
  for (const bad of [
    '',
    'hello',
    'https://vimeo.com/123456',
    'https://www.youtube.com/',
    'https://youtu.be/short',
    `https://evil.example/watch?v=${ID}`,
  ]) {
    assert.equal(videoId(bad), null, bad);
  }
});

test('start times and clock display', () => {
  assert.equal(startTime(`https://youtu.be/${ID}?t=90`), 90);
  assert.equal(startTime(`https://www.youtube.com/watch?v=${ID}&t=1m30s`), 90);
  assert.equal(startTime(`https://www.youtube.com/embed/${ID}?start=12`), 12);
  assert.equal(startTime(ID), 0);
  assert.equal(clock(83.4), '1:23');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(NaN), '--:--');
});

test('text settings are saved with the patch, capped and type-checked', () => {
  let p = addGear(emptyPatch(), 'deck', 1, 1);
  const deck = p.gear[1].id;
  p = setText(p, deck, 'link', `https://youtu.be/${ID}`);
  const back = parsePatch(JSON.stringify(p))!;
  assert.equal(back.gear[1].text?.['link'], `https://youtu.be/${ID}`);
  assert.equal(setText(p, deck, 'link', 'x'.repeat(2000)).gear[1].text?.['link'].length, 500);
  const junk = JSON.parse(JSON.stringify(p));
  junk.gear[1].text = { link: 42, ok: 'yes' };
  assert.deepEqual(parsePatch(JSON.stringify(junk))!.gear[1].text, { ok: 'yes' });
});
