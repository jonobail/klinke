import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import {
  type Clip,
  type Ids,
  clampVelocity,
  copyNotes,
  deleteNotes,
  duplicateNotes,
  nextStep,
  notesInBox,
  offsetNotes,
  pasteNotes,
  pick,
  prevStep,
  resizeNotes,
  setVelocity,
  shiftNotes,
  snapStep,
  stepBeats,
  stepErase,
  stepWrite,
  tieNotes,
  transposeNotes,
} from '../core/editing';
import { GEAR } from '../core/gear';
import { SWING_MAX, SWING_MIN, clampSwing, quantizeNotes } from '../core/groove';
import {
  GRIDS,
  type Grid,
  MIN_LENGTH,
  type Note,
  addNote,
  gridBeats,
  quantize,
} from '../core/notes';
import { noteName } from '../core/sound';
import { BEATS_PER_BAR, SONG_BARS, SONG_BEATS } from '../core/transport';
import { PatchStore } from '../patch-store';
import { Transport } from '../transport';

/** Piano-roll geometry: one row per semitone, C0 (12) at the bottom to C8 (108) at the top. */
const LOW = 12;
const HIGH = 108;
const RANGE = { lo: LOW, hi: HIGH };
const ROW = 12;
/** Width of the piano keys down the left. */
const KEYS = 44;
/** Zoom levels: pixels per beat. */
const ZOOMS = [10, 15, 20, 30, 40, 60, 80, 120, 160];
const STRENGTHS = [100, 75, 50];

/** Copied notes, kept across tracks; pastes go after the copy, then after each other. */
let clipboard: { clip: Clip; at: number } | null = null;
let ids = 0;
const newId = () => `d${Date.now().toString(36)}${(ids++).toString(36)}`;

/**
 * The piano roll for the open MIDI track: piano keys down the left, the song's 16 bars across, a
 * velocity lane underneath. Click to add a note, drag to move, drag the right edge to resize;
 * shift-click / shift-drag (or SELECT) to select several and edit them together. STEP writes the
 * notes you play at a step cursor instead of in time.
 */
@Component({
  selector: 'kl-piano-roll',
  templateUrl: './piano-roll.html',
  styleUrl: './piano-roll.scss',
  host: { '(keydown)': 'key($event)' },
})
export class PianoRoll {
  protected readonly transport = inject(Transport);
  private readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly injector = inject(Injector);

  protected readonly ROW = ROW;
  protected readonly KEYS = KEYS;
  protected readonly GRIDS = GRIDS;
  protected readonly STRENGTHS = STRENGTHS;
  protected readonly SWING_MIN = SWING_MIN;
  protected readonly SWING_MAX = SWING_MAX;
  protected readonly height = (HIGH - LOW + 1) * ROW;
  protected readonly rows = Array.from({ length: HIGH - LOW + 1 }, (_, i) => HIGH - i);
  protected readonly bars = Array.from({ length: SONG_BARS }, (_, i) => i);

  /** Pixels per beat (zoom). */
  protected readonly beat = signal(40);
  protected readonly width = computed(() => SONG_BEATS * this.beat());
  protected readonly bar = computed(() => BEATS_PER_BAR * this.beat());

  protected readonly track = computed(() =>
    this.transport.tracks().find((t) => t.id === this.transport.openTrack() && t.type === 'midi'),
  );
  private readonly trackId = computed(() => this.track()?.id);
  protected readonly instrumentLabel = computed(() => {
    const id = this.track()?.instrument;
    const g = id && this.store.patch().gear.find((x) => x.id === id);
    return g ? GEAR[g.kind].label : 'no instrument';
  });

  /** Selected note ids (may name notes since deleted; `sel` is the live selection). */
  protected readonly selected = signal<Ids>(new Set());
  protected readonly sel = computed<Ids>(() => {
    const s = this.selected();
    return new Set((this.track()?.notes ?? []).filter((n) => s.has(n.id)).map((n) => n.id));
  });
  /** SELECT tool: dragging on empty grid draws a selection box instead of adding a note. */
  protected readonly selectTool = signal(false);
  /** The selection box being drawn, in grid pixels. */
  protected readonly box = signal<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  protected readonly strength = signal(100);

  /** Step entry: on, and the cursor's beat. */
  protected readonly step = signal(false);
  protected readonly cursor = signal(0);
  protected readonly stepLen = computed(() => stepBeats(this.grid()));

  /** Where the track's loop ends (notes past it rest while it loops). */
  protected readonly loopEnd = computed(() => {
    const t = this.track();
    return t ? this.transport.trackLoop(t) : SONG_BEATS;
  });
  protected readonly playhead = computed(
    () => (this.transport.beats() % this.loopEnd()) * this.beat(),
  );

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  /** Keys held during step entry, the notes written for them, the last chord, and all written. */
  private readonly held = new Set<number>();
  private chord: string[] = [];
  private last = new Set<string>();
  private written = new Set<string>();
  private wheelAcc = 0;

  constructor() {
    // Open on the track's notes (or around middle C), not at the top of the range.
    afterNextRender(() => {
      const el = this.scroller()?.nativeElement;
      const notes = this.track()?.notes ?? [];
      const top = notes.length ? Math.max(...notes.map((n) => n.note)) + 3 : 72;
      if (el) el.scrollTop = this.y(top) - 10;
    });
    // Another track opened: start afresh.
    effect(() => {
      this.trackId();
      untracked(() => {
        this.selected.set(new Set());
        this.resetStep();
      });
    });
    const off = this.engine.listen((gear, note, on, velocity?: number) =>
      this.heard(gear, note, on, velocity),
    );
    inject(DestroyRef).onDestroy(() => off());
  }

  protected y(note: number) {
    return (HIGH - note) * ROW;
  }

  protected isBlack(note: number) {
    return [1, 3, 6, 8, 10].includes(note % 12);
  }

  protected label(note: number) {
    return note % 12 === 0 ? noteName(note) : '';
  }

  protected noteTitle(n: Note) {
    return `${noteName(n.note)} · ${n.start} + ${n.length} · vel ${n.velocity}`;
  }

  protected close() {
    this.transport.openTrack.set(null);
  }

  protected setGrid(e: Event) {
    const el = e.target as HTMLSelectElement;
    this.edit(() => ({ grid: el.value as Grid }));
    el.blur(); // hand the keys back to the instrument
  }

  protected clear() {
    if (this.track()?.notes.length && confirm('Clear every note on this track?')) {
      this.edit(() => ({ notes: [] }));
    }
  }

  // ── Groove ────────────────────────────────────────────

  protected setStrength(e: Event) {
    const el = e.target as HTMLSelectElement;
    this.strength.set(Number(el.value));
    el.blur();
  }

  /** QUANTIZE the selection (or every note) towards the track's grid. */
  protected quantizeNow() {
    const t = this.track();
    if (!t) return;
    if (!gridBeats(t.grid)) {
      this.store.flash('pick a GRID to quantize to');
      return;
    }
    const sel = this.sel();
    this.edit((notes) => ({
      notes: quantizeNotes(notes, t.grid, this.strength() / 100, sel.size ? sel : undefined),
    }));
  }

  protected setSwing(e: Event) {
    const swing = clampSwing((e.target as HTMLInputElement).value);
    const t = this.track();
    if (t) this.transport.updateTrack(t.id, () => ({ swing }));
  }

  protected toggleRecMode() {
    const t = this.track();
    if (t)
      this.transport.updateTrack(t.id, (tr) => ({
        recMode: tr.recMode === 'replace' ? 'overdub' : 'replace',
      }));
  }

  // ── Zoom ──────────────────────────────────────────────

  /** One zoom level in (+1) or out (−1), keeping the beat under `clientX` (or the middle) still. */
  protected zoom(dir: number, clientX?: number) {
    const el = this.scroller()?.nativeElement;
    const now = this.beat();
    const i = ZOOMS.indexOf(now);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    if (!el || next === now) return;
    const r = el.getBoundingClientRect();
    const x = (clientX ?? r.left + (r.width + KEYS) / 2) - r.left;
    const at = (el.scrollLeft + x - KEYS) / now;
    this.beat.set(next);
    afterNextRender(() => (el.scrollLeft = at * next + KEYS - x), { injector: this.injector });
  }

  /** Ctrl / Cmd + wheel (and trackpad pinch) zooms. */
  protected wheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.wheelAcc += e.deltaY;
    if (Math.abs(this.wheelAcc) < 30) return;
    this.zoom(this.wheelAcc < 0 ? 1 : -1, e.clientX);
    this.wheelAcc = 0;
  }

  // ── Editing ───────────────────────────────────────────

  private edit(change: (notes: Note[]) => Partial<{ notes: Note[]; grid: Grid }>) {
    const t = this.track();
    if (t) this.transport.updateTrack(t.id, (tr) => change(tr.notes));
  }

  private notes(): Note[] {
    return this.track()?.notes ?? [];
  }

  private grid(): Grid {
    return this.track()?.grid ?? '1/16';
  }

  /** Pointer position → (beat, note) on the grid, and pixels within it. */
  private at(e: PointerEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, beat: x / this.beat(), note: HIGH - Math.floor(y / ROW) };
  }

  private audition(note: number) {
    const id = this.track()?.instrument;
    if (!id) return;
    this.engine.noteOn(note, id, true);
    setTimeout(() => this.engine.noteOff(note, id, true), 180);
  }

  private focus() {
    this.scroller()?.nativeElement.focus({ preventScroll: true });
  }

  /** Click on empty grid: add a note one grid step long; shift-drag (or SELECT) draws a box. */
  protected gridDown(e: PointerEvent) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    this.focus();
    const el = e.currentTarget as HTMLElement;
    if (e.shiftKey || this.selectTool()) {
      this.boxSelect(e, el);
      return;
    }
    const { beat, note } = this.at(e, el);
    const step = this.stepLen();
    const start = Math.max(0, Math.min(SONG_BEATS - step, this.snapDown(beat)));
    const n: Note = { id: newId(), note, start, length: step, velocity: 100 };
    this.edit((notes) => ({ notes: addNote(notes, n) }));
    this.selected.set(new Set([n.id]));
    this.audition(note);
  }

  /** Drawing snaps to the grid line at or before the pointer, like most piano rolls. */
  private snapDown(beat: number) {
    const step = gridBeats(this.grid());
    return step ? Math.floor(beat / step) * step : beat;
  }

  /** Drag a box over notes to select them (with Shift, adding to the selection). */
  private boxSelect(e: PointerEvent, el: HTMLElement) {
    el.setPointerCapture(e.pointerId);
    const a = this.at(e, el);
    const base = e.shiftKey ? [...this.sel()] : [];
    this.selected.set(new Set(base));
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      const b = this.at(m, el);
      const [x0, x1] = [Math.max(0, Math.min(a.x, b.x)), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.max(0, Math.min(a.y, b.y)), Math.max(a.y, b.y)];
      this.box.set({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
      const hit = notesInBox(this.notes(), {
        from: x0 / this.beat(),
        to: x1 / this.beat(),
        low: HIGH - Math.floor(y1 / ROW),
        high: HIGH - Math.floor(y0 / ROW),
      });
      this.selected.set(new Set([...base, ...hit]));
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      this.box.set(null);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** Drag a note (and the rest of the selection) to move it, or its right edge to resize. */
  protected noteDown(e: PointerEvent, n: Note) {
    e.stopPropagation();
    if (e.button !== 0) return;
    this.focus();
    const sel = this.sel();
    if (e.shiftKey && sel.has(n.id)) {
      this.selected.set(new Set([...sel].filter((id) => id !== n.id)));
      return;
    }
    if (e.shiftKey) this.selected.set(new Set([...sel, n.id]));
    else if (!sel.has(n.id)) this.selected.set(new Set([n.id]));
    const group = this.sel();
    const origin = pick(this.notes(), group);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // The right edge resizes, on notes wide enough to have both a body and an edge.
    const box = el.getBoundingClientRect();
    const resizing = box.width >= 16 && e.clientX > box.right - 6;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let lastNote = n.note;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      moved ||= Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) > 2;
      const dBeats = (m.clientX - x0) / this.beat();
      if (resizing) {
        const end = quantize(n.start + n.length + dBeats, this.grid());
        const d = Math.max(MIN_LENGTH, end - n.start) - n.length;
        this.edit((notes) => ({ notes: resizeNotes(notes, origin, d) }));
        return;
      }
      const dSemis = -Math.round((m.clientY - y0) / ROW);
      const start = quantize(n.start + dBeats, this.grid());
      this.edit((notes) => ({
        notes: offsetNotes(notes, origin, start - n.start, dSemis, RANGE),
      }));
      const now = this.notes().find((x) => x.id === n.id)?.note ?? lastNote;
      if (now !== lastNote) {
        lastNote = now;
        this.audition(now);
      }
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      // A plain click on one of several selected notes selects just that one.
      if (!moved && !e.shiftKey && group.size > 1) this.selected.set(new Set([n.id]));
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected remove(n: Note) {
    this.edit((notes) => ({ notes: notes.filter((x) => x.id !== n.id) }));
  }

  /** Velocity lane: drag a bar up or down (the whole selection, if the note is in it). */
  protected velDown(e: PointerEvent, n: Note) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const lane = el.parentElement!;
    const sel = this.sel();
    const group = sel.has(n.id) ? sel : new Set([n.id]);
    const set = (m: PointerEvent) => {
      const r = lane.getBoundingClientRect();
      const v = clampVelocity(127 * (1 - (m.clientY - r.top) / r.height));
      this.edit((notes) => ({ notes: setVelocity(notes, group, v) }));
    };
    el.setPointerCapture(e.pointerId);
    set(e);
    const move = (m: PointerEvent) => m.pointerId === e.pointerId && set(m);
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected velWidth(n: Note) {
    return Math.max(3, Math.min(8, n.length * this.beat() - 1));
  }

  /** Click the ruler: moves the step cursor in STEP, otherwise the playhead. */
  protected rulerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const beat = (e.clientX - r.left) / this.beat();
    if (this.step()) {
      this.cursor.set(snapStep(beat, this.stepLen(), this.loopEnd()));
      this.chord = [];
      this.last = new Set();
    } else if (beat < this.transport.loopBeats()) this.transport.seek(this.snapDown(beat));
  }

  // ── Keys ──────────────────────────────────────────────

  protected key(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    if (this.command(e)) {
      e.preventDefault();
      e.stopPropagation(); // the floor mustn't act on it too (Delete would remove gear)
    }
  }

  /** Runs a keyboard command; false when the key isn't the roll's. */
  private command(e: KeyboardEvent): boolean {
    const sel = this.sel();
    if (e.ctrlKey || e.metaKey) {
      if (e.altKey) return false;
      switch (e.key.toLowerCase()) {
        case 'a':
          this.selected.set(new Set(this.notes().map((n) => n.id)));
          return true;
        case 'c':
          if (!sel.size) return false;
          this.copy();
          return true;
        case 'v':
          if (!clipboard) return false;
          this.paste();
          return true;
        case 'd':
          if (!sel.size) return false;
          this.duplicate();
          return true;
      }
      return false;
    }
    if (e.altKey) return false;
    if (sel.size) {
      const step = this.stepLen();
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          this.edit((notes) => ({ notes: deleteNotes(notes, sel) }));
          return true;
        case 'ArrowUp':
        case 'ArrowDown': {
          const semis = (e.shiftKey ? 12 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          this.edit((notes) => ({ notes: transposeNotes(notes, sel, semis, RANGE) }));
          const top = pick(this.notes(), sel).at(-1);
          if (top && !e.repeat) this.audition(top.note);
          return true;
        }
        case 'ArrowLeft':
        case 'ArrowRight':
          this.edit((notes) => ({
            notes: shiftNotes(notes, sel, e.key === 'ArrowLeft' ? -step : step),
          }));
          return true;
        case 'Escape':
          this.selected.set(new Set());
          return true;
      }
    }
    if (this.step()) {
      switch (e.key) {
        case 'ArrowRight':
          this.rest();
          return true;
        case 'ArrowLeft':
        case 'Backspace':
          this.back();
          return true;
        case '-':
          this.tie();
          return true;
      }
    }
    return false;
  }

  private copy() {
    const clip = copyNotes(this.notes(), this.sel(), this.grid());
    clipboard = clip && { clip, at: clip.origin + clip.span };
  }

  /** Pastes right after the copied block, then after the last paste. */
  private paste() {
    const c = clipboard;
    if (!c) return;
    if (c.at >= SONG_BEATS) {
      this.store.flash('no room left in the song to paste');
      return;
    }
    const out = pasteNotes(this.notes(), c.clip, c.at, newId);
    this.edit(() => ({ notes: out.notes }));
    this.selected.set(out.ids);
    c.at += c.clip.span;
  }

  private duplicate() {
    const out = duplicateNotes(this.notes(), this.sel(), this.grid(), newId);
    if (!out.ids.size) return;
    this.edit(() => ({ notes: out.notes }));
    this.selected.set(out.ids);
  }

  protected pianoKey(note: number) {
    this.audition(note);
    if (this.step() && !this.transport.recording()) {
      this.stepDown(note, 100);
      this.stepUp(note);
    }
  }

  // ── Step entry ────────────────────────────────────────

  protected toggleStep() {
    this.step.update((s) => !s);
    this.resetStep();
    if (this.step())
      this.cursor.set(
        snapStep(this.transport.beats() % this.loopEnd(), this.stepLen(), this.loopEnd()),
      );
  }

  private resetStep() {
    this.held.clear();
    this.chord = [];
    this.last = new Set();
    this.written = new Set();
  }

  /** Notes played on the track's instrument, by hand, while STEP is on and REC isn't. */
  private heard(gear: string, note: number, on: boolean, velocity?: number) {
    const t = this.track();
    if (!this.step() || !t || gear !== t.instrument || this.transport.recording()) {
      this.held.delete(note);
      return;
    }
    if (on) this.stepDown(note, velocity === undefined ? 100 : velocity * 127);
    else this.stepUp(note);
  }

  /** A key down writes its note at the cursor; keys down together make a chord on one step. */
  private stepDown(note: number, velocity: number) {
    if (this.held.has(note)) return;
    this.held.add(note);
    const id = newId();
    const at = this.cursor();
    this.edit((notes) => ({ notes: stepWrite(notes, note, at, this.stepLen(), velocity, id) }));
    this.chord.push(id);
    this.written.add(id);
  }

  /** The last key up moves the cursor on a step. */
  private stepUp(note: number) {
    if (!this.held.delete(note) || this.held.size) return;
    this.last = new Set(this.chord);
    this.chord = [];
    this.advance();
  }

  private advance() {
    this.cursor.set(nextStep(this.cursor(), this.stepLen(), this.loopEnd()));
  }

  /** REST: on a step without a note. */
  protected rest() {
    this.last = new Set();
    this.advance();
  }

  /** TIE: the last notes written hold on through the cursor's step. */
  protected tie() {
    const out = tieNotes(this.notes(), this.last, this.cursor(), this.stepLen());
    if (out.tied.size) this.edit(() => ({ notes: out.notes }));
    this.last = out.tied;
    this.advance();
  }

  /** BACK: a step back, taking out what step entry wrote there. */
  protected back() {
    const step = this.stepLen();
    const at = prevStep(this.cursor(), step, this.loopEnd());
    this.cursor.set(at);
    this.edit((notes) => ({ notes: stepErase(notes, this.written, at, step) }));
    this.last = new Set(
      pick(this.notes(), this.written)
        .filter((n) => Math.abs(n.start + n.length - at) < 1e-6)
        .map((n) => n.id),
    );
  }
}
