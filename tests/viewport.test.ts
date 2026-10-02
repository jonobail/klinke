import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  anchorView,
  bounds,
  clampZoom,
  edgeSpeed,
  fitBox,
  floorAt,
  revealBox,
  stepZoom,
  surfaceSize,
} from '../src/app/core/viewport.ts';

test('clampZoom keeps zoom within the limits', () => {
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(1.3), 1.3);
});

test('stepZoom moves to the next step from any zoom', () => {
  assert.equal(stepZoom(1, 1), 1.2);
  assert.equal(stepZoom(1, -1), 0.8);
  assert.equal(stepZoom(0.9, 1), 1);
  assert.equal(stepZoom(0.9, -1), 0.8);
  assert.equal(stepZoom(1.0000001, 1), 1.2);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
  assert.equal(stepZoom(0.05, -1), ZOOM_STEPS[0]);
});

test('bounds covers every box', () => {
  assert.equal(bounds([]), null);
  assert.deepEqual(
    bounds([
      { x: 10, y: 20, w: 30, h: 40 },
      { x: 50, y: 0, w: 10, h: 10 },
    ]),
    { x: 10, y: 0, w: 50, h: 60 },
  );
});

test('fitBox fits and centres a box', () => {
  // A 1000×500 box in a 400×400 view with 0 padding: width-limited at 0.4.
  const v = fitBox({ x: 100, y: 100, w: 1000, h: 500 }, { w: 400, h: 400 }, 0);
  assert.equal(v.zoom, 0.4);
  // Box centre (600, 350) × 0.4 = (240, 140), minus half the view.
  assert.equal(v.left, 40);
  assert.equal(v.top, 0); // can't scroll above the floor
  // Padding shrinks the zoom.
  assert.ok(fitBox({ x: 0, y: 0, w: 1000, h: 500 }, { w: 400, h: 400 }, 20).zoom < 0.4);
});

test('fitBox respects the zoom cap and limits', () => {
  assert.equal(fitBox({ x: 0, y: 0, w: 10, h: 10 }, { w: 400, h: 400 }, 0, 2).zoom, 2);
  assert.equal(fitBox({ x: 0, y: 0, w: 1e6, h: 10 }, { w: 400, h: 400 }, 0).zoom, MIN_ZOOM);
});

test('anchorView keeps the floor point under the anchor', () => {
  const before = { zoom: 0.5, left: 120, top: 40 };
  const at = { x: 200, y: 150 };
  const f = floorAt(before, at);
  const after = anchorView(2, f, at);
  assert.equal(after.zoom, 2);
  const g = floorAt(after, at);
  assert.ok(Math.abs(g.x - f.x) < 1e-9 && Math.abs(g.y - f.y) < 1e-9);
  // Clamped zoom still anchors.
  const far = anchorView(50, f, at);
  assert.equal(far.zoom, MAX_ZOOM);
  assert.ok(Math.abs(floorAt(far, at).x - f.x) < 1e-9);
});

test('surfaceSize leaves a screen of empty floor past the content, in whole cells', () => {
  // 1000×600 px viewport at ×1: content 1440×800 → +1000 / +600 of room.
  assert.deepEqual(surfaceSize({ w: 1440, h: 800 }, { w: 1000, h: 600 }, 1, 40), {
    w: 2440,
    h: 1400,
  });
  // At ×0.5 the same screen shows twice as much floor, so the room doubles.
  assert.deepEqual(surfaceSize({ w: 1440, h: 800 }, { w: 1000, h: 600 }, 0.5, 40), {
    w: 3440,
    h: 2000,
  });
  // Rounded up to a cell.
  assert.equal(surfaceSize({ w: 1441, h: 800 }, { w: 1000, h: 600 }, 1, 40).w, 2480);
  // Before the viewport is measured there's still some room.
  assert.deepEqual(surfaceSize({ w: 400, h: 400 }, { w: 0, h: 0 }, 1, 40), { w: 560, h: 560 });
  // Far-out content grows the floor with it.
  assert.equal(surfaceSize({ w: 40000, h: 800 }, { w: 1000, h: 600 }, 1, 40).w, 41000);
});

test('revealBox scrolls the least it can, and zooms out only when it must', () => {
  const vp = { w: 800, h: 600 };
  const view = { zoom: 1, left: 0, top: 0 };
  // Already visible: no change.
  assert.deepEqual(revealBox(view, { x: 100, y: 100, w: 200, h: 200 }, vp, 20), view);
  // Off to the right and below: scroll until its far edges are 20 px inside.
  assert.deepEqual(revealBox(view, { x: 2000, y: 1000, w: 200, h: 200 }, vp, 20), {
    zoom: 1,
    left: 2200 - 800 + 20,
    top: 1200 - 600 + 20,
  });
  // Up and to the left of the view: scroll back until its near edges are 20 px inside.
  assert.deepEqual(
    revealBox({ zoom: 0.5, left: 900, top: 900 }, { x: 100, y: 200, w: 200, h: 100 }, vp, 20),
    { zoom: 0.5, left: 30, top: 80 },
  );
  // Too big at ×2: zoom out to fit it, never in.
  const big = revealBox({ zoom: 2, left: 0, top: 0 }, { x: 0, y: 0, w: 600, h: 200 }, vp, 20);
  assert.ok(big.zoom < 2 && big.zoom > 1, String(big.zoom));
  assert.ok(revealBox(view, { x: 0, y: 0, w: 2000, h: 100 }, vp, 20).zoom < 1);
});

test('edgeSpeed ramps up near the edges and is still in the middle', () => {
  assert.equal(edgeSpeed(500, 0, 1000), 0);
  assert.equal(edgeSpeed(1000, 0, 1000), 20);
  assert.equal(edgeSpeed(1200, 0, 1000), 20); // past the edge: full speed
  assert.equal(edgeSpeed(0, 0, 1000), -20);
  assert.equal(edgeSpeed(976, 0, 1000), 10); // halfway into the 48 px band
  assert.equal(edgeSpeed(100, 0, 1000), 0);
  // A tiny viewport keeps a still middle third.
  assert.equal(edgeSpeed(50, 0, 90), 0);
  assert.ok(edgeSpeed(85, 0, 90) > 0);
});
