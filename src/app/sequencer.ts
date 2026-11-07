import { Injectable, effect, inject, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { swungNotes, unswungStart } from './core/groove';
import { earlier, secondsToBeats } from './core/metronome';
import { addNote, clearWindow, recordedNote } from './core/notes';
import { notesDue } from './core/schedule';
import { LookAhead } from './look-ahead';
import { PatchStore } from './patch-store';
import { RecSettings } from './rec-settings';
import { Transport, type Track } from './transport';

/** How often the player books notes (ms), and how far ahead of the playhead it books them (s). */
const TICK_MS = 15;
const AHEAD_S = 0.05;

interface Off {
  /** Elapsed beats (see `LookAhead`) when the note ends. */
  at: number;
  /** Audio time its note-on was booked for: an off is never sent before its on. */
  on: number;
  instrument: string;
  note: number;
}

/**
 * Plays MIDI tracks into their instruments while the transport runs, and records notes played
 * by hand into armed MIDI tracks while REC is on.
 *
 * Playback books notes a little ahead on the audio clock, so they land on the sample (gear that
 * can't book ahead gets them from a timer at the right moment; see `AudioEngine.book`).
 * Recording moves what you play back by the output latency (and the offset in REC settings), so
 * it lands where you heard the song, and takes swing back out so swung parts quantise right.
 */
@Injectable({ providedIn: 'root' })
export class Sequencer {
  private readonly transport = inject(Transport);
  private readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly rec = inject(RecSettings);

  // Playback
  private timer?: ReturnType<typeof setInterval>;
  private readonly window = new LookAhead(this.transport);
  /** The playhead at the last tick, for REPLACE recording and the loop coming round. */
  private last = 0;
  private offs: Off[] = [];

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

  /** What to take off a played position: the latency, in beats. */
  private latencyBeats(): number {
    return secondsToBeats(this.rec.latency(this.engine.context), this.transport.bpm());
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
    // Where it was heard (latency off), then off the swing, so it plays back where it was played.
    const lat = this.latencyBeats();
    const place = (b: number) => unswungStart(earlier(b, lat, loop), t.grid, t.swing);
    const n = recordedNote(id, note, place(held.at), place(to), t.grid, held.velocity, loop);
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
    this.window.reset();
    this.last = this.transport.beatNow();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stopPlayback() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.engine.cancelBooked();
    // Notes still sounding stop now; one booked to start a moment from now stops as it starts.
    const now = this.engine.context?.currentTime ?? 0;
    for (const o of this.offs) this.engine.noteOff(o.note, o.instrument, true, Math.max(now, o.on));
    this.offs = [];
  }

  private tick() {
    const now = this.transport.beatNow();
    this.replace(now); // before `fresh` empties at the loop point
    if (now < this.last) this.fresh.clear(); // round the loop again
    this.last = now;

    const bpm = this.transport.bpm();
    const w = this.window.next(secondsToBeats(AHEAD_S, bpm));
    if (!w) return;
    const ctx = this.engine.context;
    const spb = 60 / bpm;
    const ctxNow = ctx?.currentTime ?? 0;
    // The audio time of an elapsed-beat position (undefined before sound starts: play at once).
    const timeOf = (el: number) => (ctx ? ctxNow + Math.max(0, el - w.nowEl) * spb : undefined);

    type Event = { el: number; off: boolean; run: () => void };
    const events: Event[] = [];
    const tracks = this.transport.tracks();
    const solo = tracks.some((t) => t.solo);
    const gear = new Set(this.store.patch().gear.map((g) => g.id));
    const [ls, le] = [this.transport.loopStartBeats(), this.transport.loopBeats()];
    for (const t of tracks) {
      if (t.type !== 'midi' || !t.instrument || !gear.has(t.instrument)) continue;
      if (t.mute || (solo && !t.solo)) continue;
      const instrument = t.instrument;
      // A looping track plays its first bars again and again; swing moves when a note plays,
      // not where it's stored.
      const loop = this.transport.trackLoop(t);
      const { due, wrapped } = notesDue(
        swungNotes(t.notes, t.grid, t.swing, loop),
        w.from,
        w.to,
        ls,
        le,
        loop,
      );
      if (wrapped) for (const n of t.notes) this.fresh.delete(n.id); // its loop came round
      for (const { item: n, offset } of due) {
        if (this.fresh.has(n.id)) continue;
        const el = w.startEl + offset;
        const on = timeOf(el) ?? 0;
        events.push({
          el,
          off: false,
          run: () => this.engine.noteOn(n.note, instrument, true, n.velocity / 127, timeOf(el)),
        });
        this.offs.push({ at: el + n.length, on, instrument, note: n.note });
      }
    }
    // Note-offs due before the window's end, the ones just booked included.
    const due = this.offs.filter((o) => o.at < w.endEl);
    this.offs = this.offs.filter((o) => o.at >= w.endEl);
    for (const o of due) {
      events.push({
        el: o.at,
        off: true,
        run: () => this.engine.noteOff(o.note, o.instrument, true, timeOf(o.at)),
      });
    }
    // In time order, offs first at the same moment, so a repeated note re-triggers cleanly.
    events.sort((a, b) => a.el - b.el || Number(b.off) - Number(a.off));
    for (const e of events) e.run();
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
