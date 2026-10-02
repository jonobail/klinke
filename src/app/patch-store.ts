import { Injectable, computed, signal } from '@angular/core';
import type { GearKind } from './core/gear';
import {
  type JackRef,
  type Patch,
  type PatchError,
  addGear,
  connect,
  demoPatch,
  disconnect,
  emptyPatch,
  freeSpot,
  moveGear,
  parsePatch,
  removeGear,
  setParam,
  setText,
} from './core/patch';
import { clampZoom, stepZoom } from './core/viewport';

const STORAGE_KEY = 'klinke.patch.v1';
/** Screens too short for the shelf, the floor and the timeline at once. */
export const SHORT_SCREEN = '(max-height: 560px)';
/** Screens where the shelf and timeline can be put away (matches the app's small layout). */
export const SMALL_LAYOUT = '(max-width: 760px), (max-height: 560px)';

const ERRORS: Record<PatchError, string> = {
  'same-gear': "can't patch a box into itself",
  direction: 'patch an OUT jack to an IN jack',
  cycle: 'that would make a feedback loop',
  'unknown-jack': 'no such jack',
};

/** Everything on the patch floor: gear, cables, selection and the cable being patched. */
@Injectable({ providedIn: 'root' })
export class PatchStore {
  readonly patch = signal<Patch>(this.load() ?? demoPatch());
  readonly selected = signal<string | null>(null);
  /** The jack clicked first while patching a cable. */
  readonly pendingJack = signal<JackRef | null>(null);
  readonly message = signal<string | null>(null);
  /**
   * Floor zoom, continuous (1 = actual size). Opens at 0.8 so a two-synth rig fits on a laptop
   * screen; small screens fit the whole rig instead (see the floor).
   */
  readonly zoom = signal(0.8);
  /** Bumped to ask the floor to zoom out to fit all the gear (VIEW menu, loading a patch). */
  readonly fitRequest = signal(0);
  /**
   * Whether the inventory shelf and the timeline show on small screens (the floor bar toggles
   * them). Short screens, like a phone on its side, start with both put away.
   */
  readonly shelfOpen = signal(!matchMedia(SHORT_SCREEN).matches);
  readonly tracksOpen = signal(!matchMedia(SHORT_SCREEN).matches);
  /** Bumped when a whole new patch is loaded; on small screens the floor fits it to the view. */
  readonly loaded = signal(0);
  /** Gear the floor should scroll into view (set when gear is added off-screen). */
  readonly reveal = signal<{ id: string } | null>(null);

  // A fresh session counts as saved until something changes.
  private savedJson = signal(JSON.stringify(this.patch()));
  readonly dirty = computed(() => JSON.stringify(this.patch()) !== this.savedJson());
  private messageTimer?: ReturnType<typeof setTimeout>;

  add(kind: GearKind, x: number, y: number) {
    const next = addGear(this.patch(), kind, x, y);
    this.patch.set(next);
    this.selected.set(next.gear[next.gear.length - 1].id);
  }

  /** Adds gear in the first free space on the floor (there always is one) and shows it. */
  addFree(kind: GearKind) {
    const { x, y } = freeSpot(this.patch(), kind);
    const before = this.patch();
    this.add(kind, x, y);
    const id = this.selected();
    if (id && this.patch() !== before) this.reveal.set({ id });
  }

  move(id: string, x: number, y: number) {
    this.patch.update((p) => moveGear(p, id, x, y));
  }

  remove(id: string) {
    this.patch.update((p) => removeGear(p, id));
    if (this.selected() === id) this.selected.set(null);
    if (this.pendingJack()?.gear === id) this.pendingJack.set(null);
  }

  removeSelected() {
    const id = this.selected();
    if (id) this.remove(id);
  }

  setParam(id: string, param: string, value: number) {
    this.patch.update((p) => setParam(p, id, param, value));
  }

  setText(id: string, key: string, value: string) {
    this.patch.update((p) => setText(p, id, key, value));
  }

  /** First click picks a jack up, second click on another jack patches the cable. */
  clickJack(ref: JackRef) {
    const first = this.pendingJack();
    if (!first) {
      this.pendingJack.set(ref);
      return;
    }
    this.pendingJack.set(null);
    if (first.gear === ref.gear && first.jack === ref.jack) return;
    const { patch, error } = connect(this.patch(), first, ref);
    if (error) this.flash(ERRORS[error]);
    else this.patch.set(patch);
  }

  unplug(cableId: string) {
    this.patch.update((p) => disconnect(p, cableId));
  }

  clearCables() {
    this.patch.update((p) => ({ ...p, cables: [] }));
  }

  reset(demo: boolean) {
    this.patch.set(demo ? demoPatch() : emptyPatch());
    this.selected.set(null);
    this.pendingJack.set(null);
    this.loaded.update((n) => n + 1);
  }

  /** The ± buttons: one zoom step in or out. */
  zoomBy(dir: number) {
    this.zoom.update((z) => stepZoom(z, dir));
  }

  setZoom(z: number) {
    this.zoom.set(clampZoom(z));
  }

  fitAll() {
    this.fitRequest.update((n) => n + 1);
  }

  /** Counts saves, so the song (Transport) can save alongside the patch. */
  readonly saves = signal(0);

  save() {
    const json = JSON.stringify(this.patch());
    localStorage.setItem(STORAGE_KEY, json);
    this.savedJson.set(json);
    this.saves.update((n) => n + 1);
    this.flash('patch saved');
  }

  exportJson(): string {
    return JSON.stringify(this.patch(), null, 2);
  }

  importJson(json: string): boolean {
    const patch = parsePatch(json);
    if (!patch) {
      this.flash("that file isn't a KLINKE patch");
      return false;
    }
    this.patch.set(patch);
    this.selected.set(null);
    this.pendingJack.set(null);
    this.loaded.update((n) => n + 1);
    return true;
  }

  flash(text: string) {
    clearTimeout(this.messageTimer);
    this.message.set(text);
    this.messageTimer = setTimeout(() => this.message.set(null), 2500);
  }

  private load(): Patch | undefined {
    const json = localStorage.getItem(STORAGE_KEY);
    return json ? parsePatch(json) : undefined;
  }
}
