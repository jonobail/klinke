import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR } from '../core/gear';
import {
  GRIDS,
  type Grid,
  MIN_LENGTH,
  type Note,
  addNote,
  gridBeats,
  moveNote,
  quantize,
  removeNote,
  resizeNote,
} from '../core/notes';
import { noteName } from '../core/sound';
import { BEATS_PER_BAR, SONG_BARS, SONG_BEATS } from '../core/transport';
import { PatchStore } from '../patch-store';
import { Transport } from '../transport';

/** Piano-roll geometry: one row per semitone, C0 (12) at the bottom to C8 (108) at the top. */
const LOW = 12;
const HIGH = 108;
const ROW = 12;
const BEAT = 40;

/**
 * The piano roll for the open MIDI track: piano keys down the left, the song's 16 bars across.
 * Click to add a note (it plays as you place it), drag a note to move it, drag its right edge to
 * resize, double-click or select + Delete to remove. Notes snap to the track's grid.
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

  protected readonly ROW = ROW;
  protected readonly BEAT = BEAT;
  protected readonly GRIDS = GRIDS;
  protected readonly width = SONG_BEATS * BEAT;
  protected readonly height = (HIGH - LOW + 1) * ROW;
  protected readonly rows = Array.from({ length: HIGH - LOW + 1 }, (_, i) => HIGH - i);
  protected readonly bars = Array.from({ length: SONG_BARS }, (_, i) => i);
  protected readonly BAR = BEATS_PER_BAR * BEAT;

  protected readonly track = computed(() =>
    this.transport.tracks().find((t) => t.id === this.transport.openTrack() && t.type === 'midi'),
  );
  protected readonly instrumentLabel = computed(() => {
    const id = this.track()?.instrument;
    const g = id && this.store.patch().gear.find((x) => x.id === id);
    return g ? GEAR[g.kind].label : 'no instrument';
  });
  protected readonly selected = signal<string | null>(null);
  protected readonly playhead = computed(() => this.transport.beats() * BEAT);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // Open on the track's notes (or around middle C), not at the top of the range.
    afterNextRender(() => {
      const el = this.scroller()?.nativeElement;
      const notes = this.track()?.notes ?? [];
      const top = notes.length ? Math.max(...notes.map((n) => n.note)) + 3 : 72;
      if (el) el.scrollTop = this.y(top) - 10;
    });
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

  protected close() {
    this.transport.openTrack.set(null);
  }

  protected setGrid(e: Event) {
    const grid = (e.target as HTMLSelectElement).value as Grid;
    this.edit(() => ({ grid }));
  }

  protected clear() {
    if (this.track()?.notes.length && confirm('Clear every note on this track?')) {
      this.edit(() => ({ notes: [] }));
    }
  }

  // ── Editing ───────────────────────────────────────────

  private edit(change: (notes: Note[]) => Partial<{ notes: Note[]; grid: Grid }>) {
    const t = this.track();
    if (t) this.transport.updateTrack(t.id, (tr) => change(tr.notes));
  }

  private grid(): Grid {
    return this.track()?.grid ?? '1/16';
  }

  /** Pointer position → (beat, note) on the grid. */
  private at(e: PointerEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const beat = (e.clientX - r.left) / BEAT;
    const note = HIGH - Math.floor((e.clientY - r.top) / ROW);
    return { beat, note };
  }

  private audition(note: number) {
    const id = this.track()?.instrument;
    if (!id) return;
    this.engine.noteOn(note, id, true);
    setTimeout(() => this.engine.noteOff(note, id, true), 180);
  }

  /** Click on empty grid: add a note one grid step long (a 1/16 with the grid off). */
  protected gridDown(e: PointerEvent) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const { beat, note } = this.at(e, e.currentTarget as HTMLElement);
    const step = gridBeats(this.grid()) || 0.25;
    const start = Math.max(0, Math.min(SONG_BEATS - step, this.snapDown(beat)));
    const n: Note = {
      id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      note,
      start,
      length: step,
      velocity: 100,
    };
    this.edit((notes) => ({ notes: addNote(notes, n) }));
    this.selected.set(n.id);
    this.audition(note);
  }

  /** Drawing snaps to the grid line at or before the pointer, like most piano rolls. */
  private snapDown(beat: number) {
    const step = gridBeats(this.grid());
    return step ? Math.floor(beat / step) * step : beat;
  }

  /** Drag a note to move it, or its right edge to resize it. */
  protected noteDown(e: PointerEvent, n: Note) {
    e.stopPropagation();
    if (e.button !== 0) return;
    this.selected.set(n.id);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // The right edge resizes, on notes wide enough to have both a body and an edge.
    const box = el.getBoundingClientRect();
    const resizing = box.width >= 16 && e.clientX > box.right - 6;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let lastNote = n.note;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      const dBeats = (m.clientX - x0) / BEAT;
      if (resizing) {
        const end = quantize(n.start + n.length + dBeats, this.grid());
        this.edit((notes) => ({
          notes: resizeNote(notes, n.id, Math.max(MIN_LENGTH, end - n.start)),
        }));
        return;
      }
      const note = n.note - Math.round((m.clientY - y0) / ROW);
      const start = quantize(n.start + dBeats, this.grid());
      this.edit((notes) => ({ notes: moveNote(notes, n.id, start, note) }));
      if (note !== lastNote) {
        lastNote = note;
        this.audition(note);
      }
    };
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

  protected remove(n: Note) {
    this.edit((notes) => ({ notes: removeNote(notes, n.id) }));
    if (this.selected() === n.id) this.selected.set(null);
  }

  protected keyDown(note: number) {
    this.audition(note);
  }

  protected key(e: KeyboardEvent) {
    const id = this.selected();
    if (!id || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    e.preventDefault();
    e.stopPropagation(); // don't also delete the selected gear on the floor
    this.edit((notes) => ({ notes: removeNote(notes, id) }));
    this.selected.set(null);
  }
}
