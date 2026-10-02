// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESCRIPTIONS, describe } from '../src/app/core/descriptions.ts';
import { GEAR } from '../src/app/core/gear.ts';

const BRANDS = /eventide|lexicon|sony|yamaha|moog|korg|roland|e-mu|emu\b|minimoog/i;

test('every piece of gear has a short description, model names only', () => {
  for (const kind of Object.keys(GEAR) as (keyof typeof GEAR)[]) {
    const d = DESCRIPTIONS[kind];
    assert.ok(d, `${kind} has a description`);
    assert.ok(d.what.length > 3 && d.purpose.length > 10, kind);
    const text = describe(kind, GEAR[kind].label);
    assert.ok(text.length <= 260, `${kind}: ${text.length} chars`);
    assert.ok(!BRANDS.test(text), `${kind}: no brand names`);
  }
});
