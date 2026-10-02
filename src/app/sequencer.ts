import { Injectable, effect, inject, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { addNote, notesStarting, recordedNote } from './core/notes';
import { SONG_BEATS } from './core/transport';
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

  // Recording: key-down position per track and note
  private readonly down = new Map<string, number>();
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
    this.engine.listen((gear, note, on) => this.heard(gear, note, on));
  }

  // ── Recording ─────────────────────────────────────────

  private recordingTracks(gear: string): Track[] {
    if (!this.transport.recording()) return [];
    return this.transport
      .tracks()
      .filter((t) => t.type === 'midi' && t.arm && t.instrument === gear);
  }

  private heard(gear: string, note: number, on: boolean) {
    const beat = this.transport.beatNow();
    for (const t of this.recordingTracks(gear)) {
      const key = `${t.id}:${note}`;
      if (on) this.down.set(key, beat);
      else if (this.down.has(key)) this.write(t, note, this.down.get(key)!, beat, key);
    }
  }

  private write(t: Track, note: number, from: number, to: number, key: string) {
    this.down.delete(key);
    const n = recordedNote(`r${Date.now().toString(36)}${this.noteIds++}`, note, from, to, t.grid);
    this.fresh.add(n.id);
    this.transport.updateTrack(t.id, (tr) => ({ notes: addNote(tr.notes, n) }));
  }

  private finishHeld() {
    this.fresh.clear(); // out of REC: everything recorded is ordinary track data now
    const beat = this.transport.beatNow();
    for (const [key, from] of this.down) {
      const [id, note] = key.split(':');
      const t = this.transport.tracks().find((tr) => tr.id === id);
      if (t) this.write(t, Number(note), from, beat, key);
    }
    this.down.clear();
  }

  // ── Playback ──────────────────────────────────────────

  private startPlayback() {
    if (!this.transport.recording()) this.fresh.clear();
    this.last = this.transport.beatNow();
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
    const step = now >= this.last ? now - this.last : SONG_BEATS - this.last + now;
    if (step > 4) {
      // A seek or a stall: skip ahead rather than fire a burst of notes.
      this.last = now;
      return;
    }
    this.elapsed += step;
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
      for (const n of notesStarting(t.notes, this.last, now)) {
        if (this.fresh.has(n.id)) continue;
        this.engine.noteOn(n.note, t.instrument, true);
        this.offs.push({ at: this.elapsed + n.length, instrument: t.instrument, note: n.note });
      }
    }
    this.last = now;
  }
}
