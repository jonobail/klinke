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

export type PatchError = 'same-gear' | 'direction' | 'cycle' | 'unknown-jack';

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
 * The starter rig, after the KLINKE mockup: MS-20 → overdrive → reverb → MF-104 → mixer → main,
 * with a Model D on mixer channel 2.
 */
export function demoPatch(): Patch {
  let patch = emptyPatch();
  const place = (kind: GearKind, x: number, y: number) => {
    patch = addGear(patch, kind, x, y);
    return patch.gear[patch.gear.length - 1].id;
  };
  const synth = place('ms20', 1, 1);
  const drive = place('overdrive', 17, 2);
  const verb = place('reverb', 21, 2);
  const delay = place('mf104', 25, 2);
  const modelD = place('modelD', 1, 8);
  const mixer = place('mixer', 23, 8);
  patch = moveGear(patch, 'g0', 31, 8);
  const chain: [string, string, string, string][] = [
    [synth, 'out', drive, 'in'],
    [drive, 'out', verb, 'in'],
    [verb, 'out', delay, 'in'],
    [delay, 'out', mixer, 'in1'],
    [modelD, 'out', mixer, 'in2'],
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
 * plugging into an occupied jack pulls the old cable out. Feedback loops are refused.
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
