import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  type History as Steps,
  canRedo,
  canUndo,
  record,
  redo,
  replace,
  startHistory,
  undo,
} from './core/history';
import type { Patch } from './core/patch';
import { MidiSync } from './midi-sync';
import { PatchStore } from './patch-store';
import { Transport, type Song, type Track } from './transport';

/** One undoable state: the patch and the song. */
interface Snapshot {
  patch: Patch;
  song: Song;
}

/** Track switches that aren't edits: arming, muting and soloing don't make undo steps. */
const FLAGS = ['arm', 'mute', 'solo'] as const;

/** The same track apart from its switches (everything compared by reference: cheap). */
function sameTrack(a: Track, b: Track): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((FLAGS as readonly string[]).includes(k)) continue;
    if (a[k as keyof Track] !== b[k as keyof Track]) return false;
  }
  return true;
}

const sameSong = (a: Song, b: Song, tempo = true) =>
  (!tempo || a.bpm === b.bpm) &&
  a.loopStart === b.loopStart &&
  a.loopBars === b.loopBars &&
  a.tracks.length === b.tracks.length &&
  a.tracks.every((t, i) => sameTrack(t, b.tracks[i]));

/**
 * Undo / redo across the patch floor and the timeline. It watches the patch and the song and
 * records each change; rapid changes (a knob or note being dragged) group into one step, and so
 * do a whole gear drag (it ends when the box settles) and everything recorded in one pass of REC. Arm / mute / solo, and tempo following an external
 * MIDI clock, aren't steps.
 */
@Injectable({ providedIn: 'root' })
export class UndoHistory {
  private readonly store = inject(PatchStore);
  private readonly transport = inject(Transport);
  private readonly sync = inject(MidiSync);

  private readonly steps = signal<Steps<Snapshot>>(startHistory(this.snapshot()));
  readonly canUndo = computed(() => canUndo(this.steps()));
  readonly canRedo = computed(() => canRedo(this.steps()));

  /** Counts REC passes, so each one is one undo step however long it runs. */
  private pass = 0;
  private wasRecording = false;

  constructor() {
    effect(() => {
      const next = { patch: this.store.patch(), song: this.transport.song() };
      const recording = this.transport.recording();
      untracked(() => this.observe(next, recording));
    });
  }

  undo() {
    if (!this.canUndo()) return;
    this.steps.update(undo);
    this.put(this.steps().present);
  }

  redo() {
    if (!this.canRedo()) return;
    this.steps.update(redo);
    this.put(this.steps().present);
  }

  /** Forgets every step (a different project was opened): what's there now is the start. */
  clear() {
    this.steps.set(startHistory(this.snapshot()));
  }

  private snapshot(): Snapshot {
    return { patch: this.store.patch(), song: this.transport.song() };
  }

  private observe(next: Snapshot, recording: boolean) {
    if (recording && !this.wasRecording) this.pass++;
    this.wasRecording = recording;
    // One REC pass, or one gear drag (however slow), is one step. Asked every time, so a drag
    // that settles without moving still ends.
    const at = performance.now();
    const drag = this.store.editGroup(at);
    const now = this.steps().present;
    const same = now.patch === next.patch && sameSong(now.song, next.song, !this.sync.external());
    if (same) {
      // Nothing undoable changed (or this is an undo / redo arriving): keep it without a step.
      this.steps.update((h) => replace(h, next));
      return;
    }
    const group = recording ? `rec${this.pass}` : drag;
    this.steps.update((h) => record(h, next, at, group));
  }

  /** Puts a step back, keeping each track's current arm / mute / solo. */
  private put(s: Snapshot) {
    const live = new Map(this.transport.tracks().map((t) => [t.id, t]));
    const tracks = s.song.tracks.map((t) => {
      const l = live.get(t.id);
      return l ? { ...t, arm: l.arm, mute: l.mute, solo: l.solo } : t;
    });
    this.store.restore(s.patch);
    // Following an external clock, the tempo is the clock's, not the step's.
    const bpm = this.sync.external() ? this.transport.bpm() : s.song.bpm;
    this.transport.applySong({ ...s.song, bpm, tracks });
  }
}
