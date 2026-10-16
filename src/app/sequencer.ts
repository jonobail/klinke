import { Injectable, effect, inject, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { swungNotes } from './core/groove';
import { addNote, clearWindow, notesStarting, recordedNote } from './core/notes';
import { PatchStore } from './patch-store';
import { Transport, type Track } from './transport';

/** How often the player checks for notes due (ms). */
const TICK_MS = 5;

/**
 * Plays MIDI tracks into their instruments while the transport runs, and records notes played
 * by hand into armed MIDI tracks while REC is on.
 */
@Injectable({ providedIn: 'root' })
export class Sequencer {
  private readonly transport = inject(Transport);
  private readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);

  // Playback
  private timer?: ReturnType<typeof setInterval>;
  private last = 0;
  /** Song beats elapsed since PLAY (keeps counting across the loop point), for note-offs. */
  private elapsed = 0;
  private offs: { at: number; instrument: string; note: number }[] = [];

  // Recording: key-down position and velocity (1–127) per track and note
  private readonly down = new Map<string, { at: number; velocity: number }>();
  private noteIds = 0;
  /**
   * Notes recorded in this pass round the loop. Their start may have snapped forward onto a grid
   * line not yet reached; they've already sounded (played by hand), so playback skips them until
   * the loop comes round again.
   */
  private readonly fresh = new Set<string>();

  constructor() {
    effect(() => {
      if (this.transport.playing()) untracked(() => this.startPlayback());
      else untracked(() => this.stopPlayback());
    });
    // Leaving REC finishes any note still held.
    effect(() => {
      if (!this.transport.recording()) untracked(() => this.finishHeld());
    });
    this.engine.listen((gear, note, on, velocity) => this.heard(gear, note, on, velocity));
  }

  // ── Recording ─────────────────────────────────────────

  private recordingTracks(gear: string): Track[] {
    if (!this.transport.recording()) return [];
    return this.transport
      .tracks()
      .filter((t) => t.type === 'midi' && t.arm && t.instrument === gear);
  }

  private heard(gear: string, note: number, on: boolean, velocity: number) {
    const beat = this.transport.beatNow();
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    for (const t of this.recordingTracks(gear)) {
      const key = `${t.id}:${note}`;
      const held = this.down.get(key);
      if (on) this.down.set(key, { at: beat, velocity: vel });
      else if (held) this.write(t, note, held, beat, key);
    }
  }

  private write(
    t: Track,
    note: number,
    held: { at: number; velocity: number },
    to: number,
    key: string,
  ) {
    this.down.delete(key);
    const id = `r${Date.now().toString(36)}${this.noteIds++}`;
    const loop = this.transport.trackLoop(t);
    const n = recordedNote(id, note, held.at, to, t.grid, held.velocity, loop);
    this.fresh.add(n.id);
    this.transport.updateTrack(t.id, (tr) => ({ notes: addNote(tr.notes, n) }));
  }

  private finishHeld() {
    this.fresh.clear(); // out of REC: everything recorded is ordinary track data now
    const beat = this.transport.beatNow();
    for (const [key, held] of this.down) {
      const [id, note] = key.split(':');
      const t = this.transport.tracks().find((tr) => tr.id === id);
      if (t) this.write(t, Number(note), held, beat, key);
    }
    this.down.clear();
  }

  // ── Playback ──────────────────────────────────────────

  private startPlayback() {
    if (!this.transport.recording()) this.fresh.clear();
    // From just before where PLAY started, so a note right on that spot plays too.
    this.last = this.transport.beats() - 1e-6;
    this.elapsed = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopPlayback() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const o of this.offs) this.engine.noteOff(o.note, o.instrument, true);
    this.offs = [];
  }

  private tick() {
    const now = this.transport.beatNow();
    const step = now >= this.last ? now - this.last : this.transport.loopBeats() - this.last + now;
    if (step > 4) {
      // A seek or a stall: skip ahead rather than fire a burst of notes.
      this.last = now;
      return;
    }
    this.elapsed += step;
    this.replace(now); // before `fresh` empties at the loop point
    if (now < this.last) this.fresh.clear(); // round the loop again

    // Note-offs first, so a repeated note re-triggers cleanly.
    const due = this.offs.filter((o) => o.at <= this.elapsed);
    this.offs = this.offs.filter((o) => o.at > this.elapsed);
    for (const o of due) this.engine.noteOff(o.note, o.instrument, true);

    const tracks = this.transport.tracks();
    const solo = tracks.some((t) => t.solo);
    const gear = new Set(this.store.patch().gear.map((g) => g.id));
    for (const t of tracks) {
      if (t.type !== 'midi' || !t.instrument || !gear.has(t.instrument)) continue;
      if (t.mute || (solo && !t.solo)) continue;
      // A looping track plays its first bars again and again: work in its own loop's beats.
      const loop = this.transport.trackLoop(t);
      const from = this.last % loop;
      const to = now % loop;
      if (to < from) for (const n of t.notes) this.fresh.delete(n.id); // its loop came round
      // Swing moves when a note plays, not where it's stored.
      for (const n of notesStarting(swungNotes(t.notes, t.grid, t.swing, loop), from, to)) {
        if (this.fresh.has(n.id)) continue;
        this.engine.noteOn(n.note, t.instrument, true, n.velocity / 127);
        this.offs.push({ at: this.elapsed + n.length, instrument: t.instrument, note: n.note });
      }
    }
    this.last = now;
  }

  /**
   * REPLACE recording: as the playhead moves over an armed replace-mode track, the notes already
   * there go (the ones recorded this pass stay).
   */
  private replace(now: number) {
    if (!this.transport.recording()) return;
    for (const t of this.transport.tracks()) {
      if (t.type !== 'midi' || !t.arm || t.recMode !== 'replace') continue;
      const loop = this.transport.trackLoop(t);
      const notes = clearWindow(t.notes, this.last % loop, now % loop, this.fresh, loop);
      if (notes !== t.notes) this.transport.updateTrack(t.id, () => ({ notes }));
    }
  }
}
