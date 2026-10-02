import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { DEFAULT_GRID, type Grid, GRIDS, type Note, parseNotes } from './core/notes';
import { SONG_BEATS, beatsAfter, clampBpm, formatPosition } from './core/transport';
import { PatchStore } from './patch-store';

export interface Track {
  id: string;
  name: string;
  /** AUDIO records sound (still to come); MIDI records notes and plays an instrument. */
  type: 'audio' | 'midi';
  /** What feeds an audio track, shown on its takes. */
  source: string;
  /** The gear a MIDI track plays (a synth or the SP-1200), by gear id. */
  instrument: string | null;
  notes: Note[];
  /** Quantise grid for recording and drawing on a MIDI track. */
  grid: Grid;
  arm: boolean;
  mute: boolean;
  solo: boolean;
  /** Recorded regions on audio tracks, in beats (audio capture is still to come). */
  takes: { start: number; end: number }[];
}

const SONG_KEY = 'klinke.song.v1';

const track = (id: string, name: string, over: Partial<Track> = {}): Track => ({
  id,
  name,
  type: 'audio',
  source: 'MIX BUS',
  instrument: null,
  notes: [],
  grid: DEFAULT_GRID,
  arm: false,
  mute: false,
  solo: false,
  takes: [],
  ...over,
});

/** The song clock (play / stop / record / tempo) and the timeline tracks it drives. */
@Injectable({ providedIn: 'root' })
export class Transport {
  private readonly store = inject(PatchStore);

  readonly bpm = signal(120);
  readonly playing = signal(false);
  readonly recording = signal(false);
  /** Song position in beats (updated every frame while playing). */
  readonly beats = signal(0);
  readonly position = computed(() => formatPosition(this.beats()));
  readonly tracks = signal<Track[]>([
    track('t0', 'MAIN'),
    track('t1', 'TRACK 1', { type: 'midi' }),
    track('t2', 'TRACK 2', { arm: true }),
  ]);
  /** The MIDI track open in the piano roll. */
  readonly openTrack = signal<string | null>(null);

  private startBeat = 0;
  private startTime = 0;
  private frame = 0;

  constructor() {
    this.load();
    // SAVE (and Ctrl+S) saves the song with the patch.
    let first = true;
    effect(() => {
      this.store.saves();
      if (first) {
        first = false;
        return;
      }
      untracked(() => this.save());
    });
  }

  /** The exact song position right now (the `beats` signal only updates once a frame). */
  beatNow(): number {
    if (!this.playing()) return this.beats();
    return beatsAfter(this.startBeat, (performance.now() - this.startTime) / 1000, this.bpm());
  }

  play() {
    if (this.playing()) return;
    this.startBeat = this.beats();
    this.startTime = performance.now();
    this.playing.set(true);
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    if (!this.playing()) {
      this.beats.set(0); // a second STOP returns to the top, as on most recorders
      return;
    }
    cancelAnimationFrame(this.frame);
    this.playing.set(false);
    this.recording.set(false);
  }

  toggle() {
    if (this.playing()) this.stop();
    else this.play();
  }

  rewind() {
    this.seek(0);
  }

  seek(beats: number) {
    const b = Math.max(0, Math.min(SONG_BEATS - 1e-6, beats));
    this.beats.set(b);
    this.startBeat = b;
    this.startTime = performance.now();
  }

  /** REC drops in on the armed tracks, starting playback if needed. */
  record() {
    if (this.recording()) {
      this.recording.set(false);
      return;
    }
    if (!this.tracks().some((t) => t.arm)) return;
    this.recording.set(true);
    this.beginTakes();
    this.play();
  }

  setBpm(bpm: number) {
    // Re-anchor so the position doesn't jump when the tempo changes mid-play.
    this.startBeat = this.beats();
    this.startTime = performance.now();
    this.bpm.set(clampBpm(bpm));
  }

  // ── Tracks ────────────────────────────────────────────

  addTrack() {
    this.tracks.update((ts) => {
      const n = Math.max(0, ...ts.map((t) => Number(t.id.slice(1)) || 0)) + 1;
      return [...ts, track(`t${n}`, `TRACK ${ts.length}`)];
    });
  }

  toggleFlag(index: number, flag: 'arm' | 'mute' | 'solo') {
    this.tracks.update((ts) => ts.map((t, i) => (i === index ? { ...t, [flag]: !t[flag] } : t)));
  }

  updateTrack(id: string, change: (t: Track) => Partial<Track>) {
    this.tracks.update((ts) => ts.map((t) => (t.id === id ? { ...t, ...change(t) } : t)));
  }

  /** Switch a track between AUDIO and MIDI; a new MIDI track plays the current keyboard synth. */
  setType(id: string, type: Track['type'], instrument: string | null) {
    this.updateTrack(id, (t) => ({ type, instrument: t.instrument ?? instrument }));
    if (type === 'midi') this.openTrack.set(id);
    else if (this.openTrack() === id) this.openTrack.set(null);
  }

  // ── Persistence ───────────────────────────────────────

  private save() {
    const song = { bpm: this.bpm(), tracks: this.tracks().map((t) => ({ ...t, takes: [] })) };
    try {
      localStorage.setItem(SONG_KEY, JSON.stringify(song));
    } catch {
      this.store.flash("couldn't save the song");
    }
  }

  private load() {
    try {
      const raw = JSON.parse(localStorage.getItem(SONG_KEY) ?? 'null');
      if (!raw || !Array.isArray(raw.tracks)) return;
      if (Number.isFinite(raw.bpm)) this.bpm.set(clampBpm(raw.bpm));
      const tracks = raw.tracks
        .filter((t: Partial<Track>) => t && typeof t.id === 'string' && typeof t.name === 'string')
        .map((t: Partial<Track>) =>
          track(t.id!, t.name!, {
            type: t.type === 'midi' ? 'midi' : 'audio',
            source: typeof t.source === 'string' ? t.source : 'MIX BUS',
            instrument: typeof t.instrument === 'string' ? t.instrument : null,
            notes: parseNotes(t.notes),
            grid: GRIDS.includes(t.grid as Grid) ? (t.grid as Grid) : DEFAULT_GRID,
            arm: !!t.arm,
            mute: !!t.mute,
            solo: !!t.solo,
          }),
        );
      if (tracks.length) this.tracks.set(tracks);
    } catch {
      // A damaged save: keep the defaults.
    }
  }

  // ── Clock ─────────────────────────────────────────────

  private beginTakes() {
    const at = this.beats();
    this.tracks.update((ts) =>
      ts.map((t) =>
        t.arm && t.type === 'audio' ? { ...t, takes: [...t.takes, { start: at, end: at }] } : t,
      ),
    );
  }

  private tick = (now: number) => {
    const prev = this.beats();
    const next = beatsAfter(this.startBeat, (now - this.startTime) / 1000, this.bpm());
    this.beats.set(next);
    if (this.recording()) {
      // Wrapping round the loop starts a fresh take at the top.
      if (next < prev) this.beginTakes();
      else this.extendTakes(next);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private extendTakes(end: number) {
    this.tracks.update((ts) =>
      ts.map((t) => {
        if (!t.arm || t.type !== 'audio' || !t.takes.length) return t;
        const takes = t.takes.slice();
        takes[takes.length - 1] = { ...takes[takes.length - 1], end };
        return { ...t, takes };
      }),
    );
  }
}
