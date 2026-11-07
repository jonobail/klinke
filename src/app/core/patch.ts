// The patch: the gear standing on the floor and the cables between their jacks. Every function
// here is pure and returns a new Patch, so the store can keep history and tests stay simple.

import { GEAR, type GearKind, defaultParams, jackDef } from './gear.ts';

/** Floor cell size in px at zoom ×1. */
export const CELL = 40;
/**
 * The starting floor, in cells: where the demo rig and a new patch's output are laid out, and
 * the least the floor ever shows. The floor itself has no edge to the right or below; it grows
 * with the gear (see `floorExtent`).
 */
export const FLOOR_W = 36;
export const FLOOR_H = 20;
/** Gear keeps x, y ≥ 0 and below this many cells: far enough to be endless, small enough for the DOM. */
export const FLOOR_LIMIT = 1000;

export interface Gear {
  id: string;
  kind: GearKind;
  /** Top-left corner, in cells. */
  x: number;
  y: number;
  params: Record<string, number>;
  /** Text settings, e.g. the SH-101's stored sequence. Most gear has none. */
  text?: Record<string, string>;
}

/** Longest text value kept (a pasted link with its tracking junk fits easily). */
const TEXT_MAX = 500;

export interface JackRef {
  gear: string;
  jack: string;
}

export interface Cable {
  id: string;
  from: JackRef; // always an output
  to: JackRef; // always an input
}

export interface Patch {
  gear: Gear[];
  cables: Cable[];
  nextId: number;
}

export type PatchError = 'same-gear' | 'direction' | 'signal' | 'cycle' | 'unknown-jack';

export const emptyPatch = (): Patch => {
  const out = GEAR.output;
  return {
    gear: [
      { id: 'g0', kind: 'output', x: FLOOR_W - out.w - 1, y: 4, params: defaultParams('output') },
    ],
    cables: [],
    nextId: 1,
  };
};

/**
 * The starter rig: CHORD-8 plays the JUPITER-8 over a NOTE cable, into mixer channel 1, with the
 * TR-606 on channel 2; the mixer feeds main. The keys play CHORD-8 (the first gear on the floor).
 */
export function demoPatch(): Patch {
  let patch = emptyPatch();
  const place = (kind: GearKind, x: number, y: number) => {
    patch = addGear(patch, kind, x, y);
    return patch.gear[patch.gear.length - 1].id;
  };
  const chords = place('chords', 1, 1);
  const drums = place('tr606', 16, 1);
  const mixer = place('mixer', 30, 1);
  const poly = place('jupiter8', 1, 9);
  patch = moveGear(patch, 'g0', 31, 8);
  const chain: [string, string, string, string][] = [
    [chords, 'notesOut', poly, 'notesIn'],
    [poly, 'out', mixer, 'in1'],
    [drums, 'out', mixer, 'in2'],
    [mixer, 'out', 'g0', 'in'],
  ];
  for (const [g1, j1, g2, j2] of chain) {
    patch = connect(patch, { gear: g1, jack: j1 }, { gear: g2, jack: j2 }).patch;
  }
  return patch;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Snaps a piece of gear to whole cells on the floor. The floor starts at (0, 0) and runs on to
 * the right and down as far as anyone needs (up to FLOOR_LIMIT cells).
 */
export function clampToFloor(kind: GearKind, x: number, y: number): { x: number; y: number } {
  const def = GEAR[kind];
  const at = (v: number, size: number) =>
    Number.isFinite(v) ? clamp(Math.round(v), 0, FLOOR_LIMIT - size) : 0;
  return { x: at(x, def.w), y: at(y, def.h) };
}

/**
 * How far the gear reaches, in cells: the right and bottom edges of the furthest boxes, never
 * less than the starting floor.
 */
export function floorExtent(patch: Patch): { w: number; h: number } {
  let w = FLOOR_W;
  let h = FLOOR_H;
  for (const g of patch.gear) {
    w = Math.max(w, g.x + GEAR[g.kind].w);
    h = Math.max(h, g.y + GEAR[g.kind].h);
  }
  return { w, h };
}

export function addGear(patch: Patch, kind: GearKind, x: number, y: number): Patch {
  if (GEAR[kind].fixed && patch.gear.some((g) => g.kind === kind)) return patch;
  const pos = clampToFloor(kind, x, y);
  const gear: Gear = { id: `g${patch.nextId}`, kind, ...pos, params: defaultParams(kind) };
  return { ...patch, gear: [...patch.gear, gear], nextId: patch.nextId + 1 };
}

/**
 * The first spot, scanning left to right then top to bottom, where the gear fits without
 * overlapping anything (keeping a cell clear around each box, and above it for its name tag).
 * Rows are as wide as the gear already reaches; when they're full the gear goes in a new row
 * below everything, so there is always a spot.
 */
export function freeSpot(patch: Patch, kind: GearKind): { x: number; y: number } {
  const def = GEAR[kind];
  const taken = patch.gear.map((g) => ({ x: g.x, y: g.y, w: GEAR[g.kind].w, h: GEAR[g.kind].h }));
  const extent = floorExtent(patch);
  const width = Math.max(extent.w, def.w + 2);
  // One row past the lowest box is always clear.
  const lastRow = Math.min(extent.h + 2, FLOOR_LIMIT - def.h);
  for (let y = 1; y <= lastRow; y++) {
    for (let x = 1; x + def.w <= width; x++) {
      const clear = taken.every(
        (t) => x + def.w < t.x || t.x + t.w < x || y + def.h < t.y - 1 || t.y + t.h < y - 1,
      );
      if (clear) return { x, y };
    }
  }
  return { x: 1, y: lastRow };
}

export function moveGear(patch: Patch, id: string, x: number, y: number): Patch {
  return {
    ...patch,
    gear: patch.gear.map((g) => (g.id === id ? { ...g, ...clampToFloor(g.kind, x, y) } : g)),
  };
}

/** Removes the gear and every cable plugged into it. Fixed gear stays. */
export function removeGear(patch: Patch, id: string): Patch {
  const gear = patch.gear.find((g) => g.id === id);
  if (!gear || GEAR[gear.kind].fixed) return patch;
  return {
    ...patch,
    gear: patch.gear.filter((g) => g.id !== id),
    cables: patch.cables.filter((c) => c.from.gear !== id && c.to.gear !== id),
  };
}

/** Sets a text setting on one piece of gear. */
export function setText(patch: Patch, id: string, key: string, value: string): Patch {
  return {
    ...patch,
    gear: patch.gear.map((g) =>
      g.id === id ? { ...g, text: { ...g.text, [key]: String(value).slice(0, TEXT_MAX) } } : g,
    ),
  };
}

/** Sets a 0–1 control value; selector knobs click to their nearest position. */
export function setParam(patch: Patch, id: string, param: string, value: number): Patch {
  return {
    ...patch,
    gear: patch.gear.map((g) => {
      if (g.id !== id) return g;
      const steps = GEAR[g.kind].params.find((d) => d.id === param)?.steps;
      let v = clamp(value, 0, 1);
      if (steps) v = Math.round(v * (steps - 1)) / (steps - 1);
      return { ...g, params: { ...g.params, [param]: v } };
    }),
  };
}

const sameJack = (a: JackRef, b: JackRef) => a.gear === b.gear && a.jack === b.jack;

export function jackDirection(patch: Patch, ref: JackRef): 'in' | 'out' | undefined {
  const gear = patch.gear.find((g) => g.id === ref.gear);
  return gear && jackDef(gear.kind, ref.jack)?.dir;
}

/** What a jack carries: 'note' events or (the default) 'audio'. */
export function jackSignal(patch: Patch, ref: JackRef): 'audio' | 'note' | undefined {
  const gear = patch.gear.find((g) => g.id === ref.gear);
  const def = gear && jackDef(gear.kind, ref.jack);
  return def && (def.signal ?? 'audio');
}

/** Is this jack an effects-loop return into a delay line (see `JackDef.returns`)? */
function isReturn(patch: Patch, ref: JackRef): boolean {
  const gear = patch.gear.find((g) => g.id === ref.gear);
  return !!gear && !!jackDef(gear.kind, ref.jack)?.returns;
}

/** Cables that carry signal forward: everything except effects-loop returns. */
const forward = (patch: Patch) => patch.cables.filter((c) => !isReturn(patch, c.to));

/** Is there a signal path from gear `a` to gear `b` through the existing cables? */
function reaches(patch: Patch, a: string, b: string): boolean {
  const cables = forward(patch);
  const seen = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const g = stack.pop()!;
    if (g === b) return true;
    if (seen.has(g)) continue;
    seen.add(g);
    for (const c of cables) if (c.from.gear === g) stack.push(c.to.gear);
  }
  return false;
}

/**
 * Patches a cable between two jacks, in either click order. Each jack holds one cable, so
 * plugging into an occupied jack pulls the old cable out. Feedback loops are refused, and so are
 * cables between an audio jack and a NOTE jack. Note and audio cables share one reachability
 * graph: a loop is a loop whatever its cables carry.
 */
export function connect(
  patch: Patch,
  a: JackRef,
  b: JackRef,
): { patch: Patch; error?: PatchError } {
  const da = jackDirection(patch, a);
  const db = jackDirection(patch, b);
  if (!da || !db) return { patch, error: 'unknown-jack' };
  if (a.gear === b.gear) return { patch, error: 'same-gear' };
  if (da === db) return { patch, error: 'direction' };
  if (jackSignal(patch, a) !== jackSignal(patch, b)) return { patch, error: 'signal' };
  const [from, to] = da === 'out' ? [a, b] : [b, a];
  const kept = patch.cables.filter((c) => !sameJack(c.from, from) && !sameJack(c.to, to));
  // A loop through an effects-loop return is fine: it goes round a delay line.
  if (!isReturn(patch, to) && reaches({ ...patch, cables: kept }, to.gear, from.gear)) {
    return { patch, error: 'cycle' };
  }
  const cable: Cable = { id: `c${patch.nextId}`, from, to };
  return { patch: { ...patch, cables: [...kept, cable], nextId: patch.nextId + 1 } };
}

export function disconnect(patch: Patch, cableId: string): Patch {
  return { ...patch, cables: patch.cables.filter((c) => c.id !== cableId) };
}

/** The cable plugged into a jack, if any. */
export const cableAt = (patch: Patch, ref: JackRef): Cable | undefined =>
  patch.cables.find((c) => sameJack(c.from, ref) || sameJack(c.to, ref));

/** Gear ids ordered so every source comes before what it feeds (the audio graph build order). */
export function signalOrder(patch: Patch): string[] {
  const cables = forward(patch);
  const indegree = new Map(patch.gear.map((g) => [g.id, 0]));
  for (const c of cables) indegree.set(c.to.gear, (indegree.get(c.to.gear) ?? 0) + 1);
  const queue = patch.gear.filter((g) => indegree.get(g.id) === 0).map((g) => g.id);
  const order: string[] = [];
  while (queue.length) {
    const g = queue.shift()!;
    order.push(g);
    for (const c of cables) {
      if (c.from.gear !== g) continue;
      const n = indegree.get(c.to.gear)! - 1;
      indegree.set(c.to.gear, n);
      if (n === 0) queue.push(c.to.gear);
    }
  }
  return order;
}

/** Jack centre in floor px at zoom ×1. */
export function jackPoint(gear: Gear, jack: string): { x: number; y: number } {
  const def = GEAR[gear.kind];
  const j = jackDef(gear.kind, jack)!;
  return { x: (gear.x + j.fx * def.w) * CELL, y: (gear.y + j.fy * def.h) * CELL };
}

/** How far a hanging cable's control points drop below its ends, in floor px. */
const cableSag = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  40 + Math.hypot(b.x - a.x, b.y - a.y) * 0.25;

/**
 * Everything drawn on the floor, in floor px at zoom ×1: how far right the gear reaches and how
 * far down the gear and its hanging cables reach. The floor's scroll area is sized from this.
 */
export function drawnExtent(patch: Patch): { w: number; h: number } {
  const cells = floorExtent(patch);
  let h = cells.h * CELL;
  const byId = new Map(patch.gear.map((g) => [g.id, g]));
  for (const c of patch.cables) {
    const from = byId.get(c.from.gear);
    const to = byId.get(c.to.gear);
    if (!from || !to || !jackDef(from.kind, c.from.jack) || !jackDef(to.kind, c.to.jack)) continue;
    const a = jackPoint(from, c.from.jack);
    const b = jackPoint(to, c.to.jack);
    // The lowest point of the curve is 3/4 of the sag below its ends' midpoint, at most.
    h = Math.max(h, Math.max(a.y, b.y) + cableSag(a, b) * 0.75 + 8);
  }
  return { w: cells.w * CELL, h: Math.ceil(h) };
}

/** A hanging cable between two points: an SVG cubic path that sags under its own weight. */
export function cablePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const sag = cableSag(a, b);
  const r = (n: number) => Math.round(n);
  return `M${r(a.x)} ${r(a.y)} C${r(a.x)} ${r(a.y + sag)} ${r(b.x)} ${r(b.y + sag)} ${r(b.x)} ${r(b.y)}`;
}

/** Gear kinds that have been replaced: old saved patches load with the new gear in its place. */
const RENAMED: Record<string, GearKind> = { synth: 'ms20' };

/** Reads a stored patch, dropping anything that no longer matches the catalog. */
export function parsePatch(json: string): Patch | undefined {
  try {
    const raw = JSON.parse(json) as Patch;
    if (!Array.isArray(raw?.gear) || !Array.isArray(raw?.cables)) return undefined;
    const gear = raw.gear
      .map((g) => (g && g.kind in RENAMED ? { ...g, kind: RENAMED[g.kind], params: {} } : g))
      .filter((g) => g && g.kind in GEAR)
      .map((g) => ({
        id: String(g.id),
        kind: g.kind,
        ...clampToFloor(g.kind, Number(g.x) || 0, Number(g.y) || 0),
        params: { ...defaultParams(g.kind), ...g.params },
        ...(g.text ? { text: cleanText(g.text) } : {}),
      }));
    if (!gear.some((g) => g.kind === 'output')) return undefined;
    let patch: Patch = { gear, cables: [], nextId: Number(raw.nextId) || gear.length + 1 };
    for (const c of raw.cables) patch = connect(patch, c.from, c.to).patch;
    return { ...patch, nextId: Math.max(patch.nextId, Number(raw.nextId) || 0) };
  } catch {
    return undefined;
  }
}

/** Only string values, each capped, from a stored `text` object. */
function cleanText(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, (v as string).slice(0, TEXT_MAX)]),
  );
}

// ---- keeping gear apart ----

/** A box's footprint in cells, with the row above it where its name tag hangs. */
function footprint(kind: GearKind, x: number, y: number) {
  const def = GEAR[kind];
  return { x, y: y - 1, w: def.w, h: def.h + 1 };
}

/** Would gear `id` (of `kind`) at (x, y) overlap another box or the name tag above one? */
export function clashes(patch: Patch, id: string, kind: GearKind, x: number, y: number): boolean {
  const a = footprint(kind, x, y);
  return patch.gear.some((g) => {
    if (g.id === id) return false;
    const b = footprint(g.kind, g.x, g.y);
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  });
}

/**
 * The free spot nearest (x, y) for gear `id`, so a box dropped on top of another slides off it
 * to the closest place it fits. Searches rings outwards; once one ring has a free spot, rings a
 * little further out are checked too, since a diagonal spot can be nearer than it looks.
 */
export function nearestFree(
  patch: Patch,
  id: string,
  kind: GearKind,
  x: number,
  y: number,
): { x: number; y: number } {
  const at = clampToFloor(kind, x, y);
  if (!clashes(patch, id, kind, at.x, at.y)) return at;
  const def = GEAR[kind];
  const ok = (cx: number, cy: number) =>
    cx >= 0 &&
    cy >= 0 &&
    cx <= FLOOR_LIMIT - def.w &&
    cy <= FLOOR_LIMIT - def.h &&
    !clashes(patch, id, kind, cx, cy);
  let best: { x: number; y: number; d: number } | null = null;
  let stopAt = Infinity;
  const extent = floorExtent(patch);
  const maxR = extent.w + extent.h + def.w + def.h;
  for (let r = 1; r <= Math.min(maxR, stopAt); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = at.x + dx;
        const cy = at.y + dy;
        if (!ok(cx, cy)) continue;
        const d = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { x: cx, y: cy, d };
      }
    }
    if (best && stopAt === Infinity) stopAt = Math.ceil(best.d);
  }
  return best ? { x: best.x, y: best.y } : freeSpot(patch, kind);
}

/** Moves gear to the free spot nearest (x, y) (see `nearestFree`). */
export function placeGear(patch: Patch, id: string, x: number, y: number): Patch {
  const g = patch.gear.find((x) => x.id === id);
  if (!g) return patch;
  const spot = nearestFree(patch, id, g.kind, x, y);
  return spot.x === g.x && spot.y === g.y ? patch : moveGear(patch, id, spot.x, spot.y);
}

// ---- cables ----

/**
 * Moves one end of a cable to another jack, keeping the other end where it is: what dragging a
 * plugged cable end does. A refused move (wrong direction, a loop) leaves the patch as it was.
 */
export function moveCableEnd(
  patch: Patch,
  cableId: string,
  end: 'from' | 'to',
  to: JackRef,
): { patch: Patch; error?: PatchError } {
  const cable = patch.cables.find((c) => c.id === cableId);
  if (!cable) return { patch, error: 'unknown-jack' };
  if (sameJack(cable[end], to)) return { patch };
  const fixed = end === 'from' ? cable.to : cable.from;
  const result = connect(disconnect(patch, cableId), fixed, to);
  return result.error ? { patch, error: result.error } : result;
}

/** Floor px around a box where a cable can't be clicked, so the controls under it can. */
const HIT_MARGIN = 8;

/**
 * The clickable part of a hanging cable: the curve sampled into polylines, leaving out every
 * stretch that crosses a box (given in floor px). A cable drawn over a panel then never takes
 * the clicks meant for the knobs beneath it. Returns an SVG path ('' when none of it is clear).
 */
export function cableHitPath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  boxes: { x: number; y: number; w: number; h: number }[],
  samples = 48,
): string {
  const sag = cableSag(a, b);
  const p1 = { x: a.x, y: a.y + sag };
  const p2 = { x: b.x, y: b.y + sag };
  const m = HIT_MARGIN;
  const covered = (x: number, y: number) =>
    boxes.some((r) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m);
  const r = (n: number) => Math.round(n);
  let d = '';
  let open = false;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const x = u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x;
    const y = u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y;
    if (covered(x, y)) {
      open = false;
      continue;
    }
    d += `${open ? 'L' : d ? ' M' : 'M'}${r(x)} ${r(y)}`;
    open = true;
  }
  return d;
}

/** Floor px a box covers (at zoom ×1), name tag not included. */
export function gearRect(g: Gear): { x: number; y: number; w: number; h: number } {
  const def = GEAR[g.kind];
  return { x: g.x * CELL, y: g.y * CELL, w: def.w * CELL, h: def.h * CELL };
}
