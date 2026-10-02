// Patch-floor viewport maths: zoom limits and steps, fitting a box into the view, and keeping a
// floor point under the fingers while pinching. Pure, so it can be tested without a browser.

/** Zoom limits for the patch floor (1 = one floor px per screen px). */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

/** Where the ± buttons stop; zoom itself is continuous (pinch, ctrl+wheel, fit). */
export const ZOOM_STEPS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.4, 1.7, 2, 2.5, 3];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * The next zoom step in a direction from any (continuous) zoom: from ×0.9, zoom in goes to ×1 and
 * zoom out to ×0.8. Small rounding differences count as being on the step.
 */
export function stepZoom(z: number, dir: number): number {
  const eps = 1e-3;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + eps) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (dir < 0) return [...ZOOM_STEPS].reverse().find((s) => s < z - eps) ?? ZOOM_STEPS[0];
  return z;
}

/** The smallest box holding all the boxes, or null when there are none. */
export function bounds(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const b = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: b - y };
}

export interface View {
  zoom: number;
  /** Scroll offset in screen px. */
  left: number;
  top: number;
}

/**
 * The view that shows a box (floor px) as large as possible in a viewport (screen px), with
 * `pad` screen px around it, centred, zoom capped at `max`.
 */
export function fitBox(box: Box, viewport: Size, pad = 16, max = MAX_ZOOM): View {
  const w = Math.max(1, viewport.w - pad * 2);
  const h = Math.max(1, viewport.h - pad * 2);
  const zoom = clampZoom(Math.min(w / Math.max(1, box.w), h / Math.max(1, box.h), max));
  return {
    zoom,
    left: Math.max(0, (box.x + box.w / 2) * zoom - viewport.w / 2),
    top: Math.max(0, (box.y + box.h / 2) * zoom - viewport.h / 2),
  };
}

/**
 * Zooming around a point: `at` is a point in the viewport (screen px from its top-left corner)
 * and `floor` is the floor point (floor px) that should end up under it at `zoom`.
 */
export function anchorView(
  zoom: number,
  floor: { x: number; y: number },
  at: { x: number; y: number },
): View {
  const z = clampZoom(zoom);
  return { zoom: z, left: floor.x * z - at.x, top: floor.y * z - at.y };
}

/** The floor point (floor px) under a viewport point for a view. */
export function floorAt(view: View, at: { x: number; y: number }): { x: number; y: number } {
  return { x: (view.left + at.x) / view.zoom, y: (view.top + at.y) / view.zoom };
}

/**
 * The size of the floor's scroll area in floor px: everything drawn (`content`, floor px) plus
 * `room` screens of empty floor past its right and bottom edges, and never smaller than the
 * viewport (screen px) shows at `zoom`. Rounded up to whole cells so the grid ends on a line.
 */
export function surfaceSize(
  content: Size,
  viewport: Size,
  zoom: number,
  cell: number,
  room = 1,
): Size {
  const z = clampZoom(zoom);
  const fit = (c: number, v: number) => {
    const screen = Math.max(v, 0) / z;
    return Math.ceil(Math.max(c + Math.max(screen * room, cell * 4), screen) / cell) * cell;
  };
  return { w: fit(content.w, viewport.w), h: fit(content.h, viewport.h) };
}

/**
 * The view that brings a box (floor px) into sight with the least scrolling, `pad` screen px
 * clear of the edges. A box too big for the viewport at this zoom zooms out to fit it instead.
 */
export function revealBox(view: View, box: Box, viewport: Size, pad = 24): View {
  const fits =
    box.w * view.zoom <= viewport.w - pad * 2 && box.h * view.zoom <= viewport.h - pad * 2;
  if (!fits) return fitBox(box, viewport, pad, view.zoom);
  const z = view.zoom;
  const along = (pos: number, start: number, size: number, span: number) =>
    Math.max(0, Math.min(Math.max(pos, (start + size) * z - span + pad), start * z - pad));
  return {
    zoom: z,
    left: along(view.left, box.x, box.w, viewport.w),
    top: along(view.top, box.y, box.h, viewport.h),
  };
}

/**
 * Auto-scroll speed (px per frame, signed) for a pointer at `p` along an axis of a viewport
 * spanning `start`–`end`: zero in the middle, ramping up within `edge` px of either side, and
 * full speed at or past the edge.
 */
export function edgeSpeed(p: number, start: number, end: number, edge = 48, max = 20): number {
  const e = Math.max(1, Math.min(edge, (end - start) / 3));
  let v = 0;
  if (p < start + e) v = -Math.round(max * Math.min(1, (start + e - p) / e));
  else if (p > end - e) v = Math.round(max * Math.min(1, (p - (end - e)) / e));
  return v || 0; // never -0
}
