import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { clampSwing } from './core/groove';
import { DEFAULT_GRID, type Grid, GRIDS, type Note, parseNotes } from './core/notes';
import {
  BEATS_PER_BAR,
  SONG_BARS,
  beatsAfter,
  clampBpm,
  clampLoop,
  clampWindow,
  formatPosition,
  trackLoopBeats,
  wrapBeat,
} from './core/transport';
import { PatchStore } from './patch-store';
import { RecSettings } from './rec-settings';

/** A recorded stretch of audio on an audio track; the sound itself is kept in IndexedDB. */
export interface Take {
  id: string;
  /** Where it starts in the song, in beats. */
  start: number;
  /** Length in seconds (it doesn't stretch with the tempo): how long it plays. */
  duration: number;
  /** Seconds into the recording where it starts playing, once its start is trimmed (`core/takes.ts`). */
  offset?: number;
  /** Waveform peaks, 50 a second, of the whole recording, for drawing. */
  peaks: number[];
}

export interface Track {
  id: string;
  name: string;
  /** AUDIO records sound; MIDI records notes and plays an instrument. */
  type: 'audio' | 'midi';
  /** What an audio track records: 'main' for the mix, or a gear id. */
  source: string;
  /** The gear a MIDI track plays (a synth or the SP-1200), by gear id. */
  instrument: string | null;
  notes: Note[];
  /** Quantise grid for recording and drawing on a MIDI track. */
  grid: Grid;
  arm: boolean;
  mute: boolean;
  solo: boolean;
  /** Recorded audio on audio tracks. */
  takes: Take[];
  /** Bars this track repeats over (its first N bars, again and again); 0 = no loop of its own. */
  loop: number;
  /** MIDI tracks: swing in percent (50 = straight … 75), applied on playback (`core/groove.ts`). */
  swing: number;
  /** MIDI recording: OVERDUB adds to the notes, REPLACE clears what the pass records over. */
  recMode: 'overdub' | 'replace';
}

const SONG_KEY = 'klinke.song.v1';

/** A song as it's saved and exported: tempo, loop window and tracks. */
export interface Song {
  bpm: number;
  loopStart: number;
  loopBars: number;
  tracks: Track[];
}

const track = (id: string, name: string, over: Partial<Track> = {}): Track => ({
  id,
  name,
  type: 'audio',
  source: 'main',
  instrument: null,
  notes: [],
  grid: DEFAULT_GRID,
  arm: false,
  mute: false,
  solo: false,
  takes: [],
  loop: 0,
  swing: 50,
  recMode: 'overdub',
  ...over,
});

/** The song clock (play / stop / record / tempo) and the timeline tracks it drives. */
@Injectable({ providedIn: 'root' })
export class Transport {
  private readonly store = inject(PatchStore);
  private readonly recSettings = inject(RecSettings);

  readonly bpm = signal(120);
  /** The song loop window, in bars: it plays round from bar `loopStart` to the end of bar `loopBars`. */
  readonly loopStart = signal(0);
  readonly loopBars = signal(SONG_BARS);
  /** The loop's end and start in beats, and its length. */
  readonly loopBeats = computed(() => this.loopBars() * BEATS_PER_BAR);
  readonly loopStartBeats = computed(() => this.loopStart() * BEATS_PER_BAR);
  readonly loopLength = computed(() => this.loopBeats() - this.loopStartBeats());
  readonly playing = signal(false);
  readonly recording = signal(false);
  /**
   * REC's count-in from a stopped song: clicks start at `start` (a performance.now() time) and
   * the song starts recording `beats` beats later. Null when not counting in.
   */
  readonly countingIn = signal<{ start: number; beats: number } | null>(null);
  private countTimer?: ReturnType<typeof setTimeout>;
  /** Song position in beats (updated every frame while playing). */
  readonly beats = signal(0);
  readonly position = computed(() => formatPosition(this.beats()));
  readonly tracks = signal<Track[]>(defaultTracks());
  /**
   * Bumps whenever the song position jumps or the clock re-anchors (play, seek, tempo, the loop
   * wrapping round): audio takes re-line-up and recordings start a fresh take.
   */
  readonly epoch = signal(0);
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
    return beatsAfter(
      this.startBeat,
      (performance.now() - this.startTime) / 1000,
      this.bpm(),
      this.loopBeats(),
      this.loopStartBeats(),
    );
  }

  /** A song position brought into play: past the loop end it comes round into the loop. */
  wrap(beat: number): number {
    return wrapBeat(Math.max(0, beat), this.loopStartBeats(), this.loopBeats());
  }

  /** `at`: the performance.now() time the song started (a count-in's last beat), default now. */
  play(at = performance.now()) {
    if (this.playing()) return;
    this.cancelCountIn();
    this.startBeat = this.beats();
    this.startTime = Math.min(at, performance.now());
    this.playing.set(true);
    this.epoch.update((n) => n + 1);
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.countingIn()) return this.cancelCountIn();
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
    const b = Math.max(0, Math.min(this.loopBeats() - 1e-6, beats));
    this.beats.set(b);
    this.startBeat = b;
    this.startTime = performance.now();
    if (this.playing()) this.epoch.update((n) => n + 1);
  }

  /** REC drops in on the armed tracks, starting playback if needed. */
  record() {
    if (this.recording()) {
      this.recording.set(false);
      return;
    }
    if (this.countingIn()) return this.cancelCountIn();
    if (!this.tracks().some((t) => t.arm)) return;
    const bars = this.recSettings.options().countIn;
    if (this.playing() || !bars) {
      this.recording.set(true);
      this.play();
      return;
    }
    // From a stopped song: count a bar or two of clicks in, then roll and record. A moment's lead
    // lets the first click be booked on the audio clock.
    const beats = bars * BEATS_PER_BAR;
    const start = performance.now() + 60;
    const at = start + (beats * 60000) / this.bpm();
    this.countingIn.set({ start, beats });
    this.countTimer = setTimeout(() => {
      this.countingIn.set(null);
      this.recording.set(true);
      this.play(at);
    }, at - performance.now());
  }

  private cancelCountIn() {
    clearTimeout(this.countTimer);
    this.countingIn.set(null);
  }

  /** Sets the song loop's end, keeping its start. */
  setLoop(bars: number) {
    this.setLoopWindow(this.loopStart(), bars);
  }

  /**
   * Sets the song loop window (whole bars); a playhead past the new end comes round to the
   * loop start.
   */
  setLoopWindow(startBars: number, endBars: number) {
    const was = this.beatNow();
    const w = clampWindow(startBars, endBars);
    this.loopStart.set(w.start);
    this.loopBars.set(w.end);
    if (was >= this.loopBeats()) this.seek(this.loopStartBeats());
    else if (this.playing()) {
      this.startBeat = was;
      this.startTime = performance.now();
    }
  }

  /** How many beats a track repeats over (its own loop, or the song's). */
  trackLoop(t: Pick<Track, 'loop'>): number {
    return trackLoopBeats(t.loop, this.loopBeats());
  }

  setBpm(bpm: number) {
    // Re-anchor so the position doesn't jump when the tempo changes mid-play.
    this.startBeat = this.beatNow();
    this.startTime = performance.now();
    this.bpm.set(clampBpm(bpm));
    if (this.playing()) this.epoch.update((n) => n + 1);
  }

  /** Where the song clock was last anchored: a beat and its performance.now() time. */
  anchor(): { beat: number; time: number } {
    return { beat: this.startBeat, time: this.startTime };
  }

  /**
   * External MIDI clock: puts the song at `beat` as of `time` (a performance.now() time), for
   * keeping in step with the clock's ticks. A nudge, not a jump: the epoch doesn't change.
   */
  syncTo(beat: number, time = performance.now()) {
    const b = this.wrap(beat);
    this.startBeat = b;
    this.startTime = time;
    if (!this.playing()) this.beats.set(b);
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

  /** The song as it's saved: tempo, loop and tracks. */
  song(): Song {
    return {
      bpm: this.bpm(),
      loopStart: this.loopStart(),
      loopBars: this.loopBars(),
      tracks: this.tracks(),
    };
  }

  /** Saves the song (recorded takes save themselves straight away: audio is costly to lose). */
  save() {
    try {
      localStorage.setItem(SONG_KEY, JSON.stringify(this.song()));
    } catch {
      this.store.flash("couldn't save the song");
    }
  }

  /** A new project's song: the default tracks at 120 BPM over the whole song. */
  newSong(): Song {
    return { bpm: 120, loopStart: 0, loopBars: SONG_BARS, tracks: defaultTracks() };
  }

  /**
   * Puts a whole song in place (opening a project, undo / redo). The tempo and loop only move
   * when they change, so undoing a note edit doesn't re-anchor the clock.
   */
  applySong(song: Song) {
    if (song.bpm !== this.bpm()) this.setBpm(song.bpm);
    if (song.loopStart !== this.loopStart() || song.loopBars !== this.loopBars())
      this.setLoopWindow(song.loopStart, song.loopBars);
    this.tracks.set(song.tracks);
    const open = this.openTrack();
    if (open && !song.tracks.some((t) => t.id === open && t.type === 'midi'))
      this.openTrack.set(null);
  }

  /** Reads a stored or imported song, dropping anything malformed; undefined if it isn't one. */
  parseSong(raw: unknown): Song | undefined {
    const r = raw as Partial<Record<keyof Song, unknown>> | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.tracks)) return undefined;
    const w =
      r.loopBars !== undefined
        ? clampWindow(r.loopStart ?? 0, r.loopBars)
        : { start: 0, end: SONG_BARS };
    const tracks = (r.tracks as Partial<Track>[])
      .filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string')
      .map((t) =>
        track(t.id!, t.name!, {
          type: t.type === 'midi' ? 'midi' : 'audio',
          source: typeof t.source === 'string' && t.source !== 'MIX BUS' ? t.source : 'main',
          instrument: typeof t.instrument === 'string' ? t.instrument : null,
          notes: parseNotes(t.notes),
          grid: GRIDS.includes(t.grid as Grid) ? (t.grid as Grid) : DEFAULT_GRID,
          arm: !!t.arm,
          mute: !!t.mute,
          solo: !!t.solo,
          takes: parseTakes(t.takes),
          loop: clampLoop(t.loop ?? 0, true),
          swing: clampSwing(t.swing),
          recMode: t.recMode === 'replace' ? 'replace' : 'overdub',
        }),
      );
    return {
      bpm: Number.isFinite(r.bpm) ? clampBpm(r.bpm as number) : 120,
      loopStart: w.start,
      loopBars: w.end,
      tracks: tracks.length ? tracks : defaultTracks(),
    };
  }

  private load() {
    try {
      const song = this.parseSong(JSON.parse(localStorage.getItem(SONG_KEY) ?? 'null'));
      if (!song) return;
      this.bpm.set(song.bpm);
      this.loopStart.set(song.loopStart);
      this.loopBars.set(song.loopBars);
      this.tracks.set(song.tracks);
    } catch {
      // A damaged save: keep the defaults.
    }
  }

  // ── Clock ─────────────────────────────────────────────

  private tick = (now: number) => {
    const prev = this.beats();
    const next = beatsAfter(
      this.startBeat,
      (now - this.startTime) / 1000,
      this.bpm(),
      this.loopBeats(),
      this.loopStartBeats(),
    );
    this.beats.set(next);
    // Round the loop (a clock-sync nudge back a hair isn't one).
    if (prev - next > this.loopLength() / 2) this.epoch.update((n) => n + 1);
    this.frame = requestAnimationFrame(this.tick);
  };
}

function parseTakes(raw: unknown): Take[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        Number.isFinite(t.start) &&
        Number.isFinite(t.duration) &&
        t.duration > 0,
    )
    .map((t) => ({
      id: t.id,
      start: Math.max(0, t.start),
      duration: t.duration,
      ...(Number.isFinite(t.offset) && t.offset > 0 ? { offset: t.offset } : {}),
      peaks: Array.isArray(t.peaks) ? t.peaks.filter(Number.isFinite) : [],
    }));
}

/** The tracks a new song starts with. */
function defaultTracks(): Track[] {
  return [
    track('t0', 'MAIN'),
    track('t1', 'TRACK 1', { type: 'midi' }),
    track('t2', 'TRACK 2', { arm: true }),
  ];
}
