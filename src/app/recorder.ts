import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { deleteTake, getTake, putTake, takeIds } from './audio/takes-store';
import { BEATS_PER_BAR, SONG_BEATS, loopRepeats } from './core/transport';
import { encodeWav, joinChunks, peaks, trimStart } from './core/wav';
import { PatchStore } from './patch-store';
import { Transport, type Take, type Track } from './transport';

/** Shorter than this and a take is a slip of the finger: dropped. */
const MIN_TAKE_S = 0.1;

type Capture = Awaited<ReturnType<AudioEngine['capture']>>;

/** The song clock at one moment, in both audio-context seconds and song beats. */
interface Anchor {
  time: number;
  beat: number;
  bpm: number;
}

/**
 * Audio tracks: records armed tracks from their source (the mix or one piece of gear) while REC
 * runs, plays the takes back in time with the song, and bounces the mix to a WAV (EXPORT MIX).
 */
@Injectable({ providedIn: 'root' })
export class Recorder {
  private readonly transport = inject(Transport);
  private readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);

  /** Tracks recording right now → the beat their take started on (for the live REC region). */
  readonly live = signal<Record<string, number>>({});
  /** EXPORT MIX progress 0–1, or null when not exporting. */
  readonly exporting = signal<number | null>(null);

  /** Takes being recorded, by track; set the moment REC starts so a quick stop still finds them. */
  private captures = new Map<string, Promise<{ capture: Capture; anchor: Anchor; loop: number }>>();
  /** Watches looping tracks while recording, to start a new take each time their loop comes round. */
  private watch?: ReturnType<typeof setInterval>;
  private readonly buffers = new Map<string, AudioBuffer>();
  private playing: AudioBufferSourceNode[] = [];
  private generation = 0;
  private cancelExport?: () => void;

  /** What playback depends on, as one string, so re-recording MIDI notes doesn't restart takes. */
  private readonly playable = computed(() => {
    const ts = this.transport.tracks();
    const solo = ts.some((t) => t.solo);
    const rec = this.transport.recording();
    return JSON.stringify([
      this.transport.loopBeats(),
      ts
        .filter((t) => t.type === 'audio' && !t.mute && (!solo || t.solo) && !(rec && t.arm))
        .flatMap((t) =>
          t.takes.map((k) => [k.id, k.start, k.duration, this.transport.trackLoop(t)]),
        ),
    ]);
  });

  constructor() {
    // Recording follows REC; any jump in the song (or the loop coming round) starts fresh takes.
    effect(() => {
      const on = this.transport.recording() && this.exporting() === null;
      this.transport.epoch();
      untracked(() => {
        void this.finishTakes();
        clearInterval(this.watch);
        if (on) {
          this.startTakes();
          this.watch = setInterval(() => this.loopsComingRound(), 10);
        }
      });
    });
    // Takes play while the transport runs.
    effect(() => {
      const playing = this.transport.playing();
      this.transport.epoch();
      this.playable();
      this.engine.running();
      untracked(() => (playing ? this.schedule() : this.silence()));
    });
    void this.dropOrphans();
  }

  // ── Recording ─────────────────────────────────────────

  private anchor(): Anchor | undefined {
    const ctx = this.engine.context;
    if (!ctx) return undefined;
    return { time: ctx.currentTime, beat: this.transport.beatNow(), bpm: this.transport.bpm() };
  }

  private startTakes(only?: string) {
    const armed = this.transport
      .tracks()
      .filter((t) => t.type === 'audio' && t.arm && (!only || t.id === only));
    for (const t of armed) {
      const loop = this.transport.trackLoop(t);
      const pending = this.engine
        .capture(t.source)
        .then((capture) => ({ capture, anchor: this.anchor()!, loop }));
      this.captures.set(t.id, pending);
      void pending.then(({ anchor }) => {
        if (this.captures.get(t.id) === pending)
          this.live.update((l) => ({ ...l, [t.id]: anchor.beat }));
      });
    }
  }

  /** A track looping shorter than the song starts a new take each time its loop comes round. */
  private lastBeat = -1;
  private loopsComingRound() {
    const now = this.transport.beatNow();
    const last = this.lastBeat;
    this.lastBeat = now;
    if (last < 0 || now < last) return; // the song loop wrapping is an epoch: handled already
    for (const t of this.transport.tracks()) {
      const loop = this.transport.trackLoop(t);
      if (!this.captures.has(t.id) || loop >= this.transport.loopBeats()) continue;
      if (Math.floor(now / loop) !== Math.floor(last / loop)) {
        void this.finishTakes(t.id);
        this.startTakes(t.id);
      }
    }
  }

  private async finishTakes(only?: string) {
    this.lastBeat = -1;
    const done = [...this.captures].filter(([id]) => !only || id === only);
    for (const [id] of done) this.captures.delete(id);
    this.live.update((l) => {
      if (!only) return {};
      const { [only]: _, ...rest } = l;
      return rest;
    });
    for (const [trackId, pending] of done) {
      const { capture, anchor, loop } = await pending;
      const { frame, chunks } = await capture.stop();
      const ctx = this.engine.context!;
      let channels = joinChunks(chunks, 2);
      // When the first captured sample sounded, in song beats.
      let start = anchor.beat + ((frame / ctx.sampleRate - anchor.time) * anchor.bpm) / 60;
      if (start < anchor.beat) {
        // Started a moment before the song position we anchored to: trim up to it.
        channels = trimStart(
          channels,
          Math.round(((anchor.beat - start) * 60 * ctx.sampleRate) / anchor.bpm),
        );
        start = anchor.beat;
      }
      // Takes sit at their place within the track's loop, and can't run past its end.
      start %= loop;
      const room = Math.round(((loop - start) * 60 * ctx.sampleRate) / anchor.bpm);
      channels = channels.map((c) => c.subarray(0, Math.max(0, room)));
      const duration = (channels[0]?.length ?? 0) / ctx.sampleRate;
      if (duration < MIN_TAKE_S) continue;
      const take: Take = {
        id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        start,
        duration,
        peaks: peaks(channels, ctx.sampleRate),
      };
      try {
        await putTake(take.id, { sampleRate: ctx.sampleRate, channels });
      } catch {
        this.store.flash("couldn't keep the take: browser storage is full or blocked");
        continue;
      }
      this.buffers.set(take.id, this.toBuffer(channels, ctx.sampleRate));
      this.transport.updateTrack(trackId, (t) => ({ takes: [...t.takes, take] }));
      this.transport.save();
    }
  }

  clearTakes(track: Track) {
    for (const k of track.takes) {
      this.buffers.delete(k.id);
      void deleteTake(k.id).catch(() => undefined);
    }
    this.transport.updateTrack(track.id, () => ({ takes: [] }));
    this.transport.save();
  }

  /** Audio in the browser's storage that no saved track refers to any more. */
  private async dropOrphans() {
    try {
      const used = new Set(this.transport.tracks().flatMap((t) => t.takes.map((k) => k.id)));
      for (const id of await takeIds()) if (!used.has(id)) await deleteTake(id);
    } catch {
      // No IndexedDB (private mode on some browsers): takes just won't survive a reload.
    }
  }

  // ── Playback ──────────────────────────────────────────

  private toBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
    const ctx = this.engine.context!;
    const buf = ctx.createBuffer(
      channels.length,
      Math.max(1, channels[0]?.length ?? 1),
      sampleRate,
    );
    channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return buf;
  }

  private async buffer(id: string): Promise<AudioBuffer | undefined> {
    if (!this.buffers.has(id)) {
      const audio = await getTake(id).catch(() => undefined);
      if (audio && this.engine.context)
        this.buffers.set(id, this.toBuffer(audio.channels, audio.sampleRate));
    }
    return this.buffers.get(id);
  }

  private silence() {
    this.generation++;
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        // never started
      }
      s.disconnect();
    }
    this.playing = [];
  }

  private schedule() {
    this.silence();
    const gen = this.generation;
    const bus = this.engine.trackBus();
    if (!bus || !this.engine.running()) return;
    const [song, list] = JSON.parse(this.playable()) as [
      number,
      [string, number, number, number][],
    ];
    for (const [id, start, duration, loop] of list) {
      void this.buffer(id).then((buf) => {
        if (!buf || gen !== this.generation) return;
        // Anchor per take: buffers loading from storage arrive a moment later.
        const a = this.anchor()!;
        const spb = 60 / a.bpm;
        // Once per repeat of the track's loop (just once when it follows the song).
        for (const at of loopRepeats(loop, song)) {
          const from = at + start;
          const end = Math.min(from + duration / spb, at + loop, song);
          if (end <= a.beat) continue; // already behind the playhead this time round
          const src = this.engine.context!.createBufferSource();
          src.buffer = buf;
          src.connect(bus);
          const lead = Math.max(0, from - a.beat) * spb;
          const offset = Math.max(0, a.beat - from) * spb;
          src.start(a.time + lead, offset, (end - Math.max(from, a.beat)) * spb);
          this.playing.push(src);
        }
      });
    }
  }

  // ── EXPORT MIX ────────────────────────────────────────

  /** How much of the song to bounce: through the last note or take, plus a bar for tails. */
  private songBeats(): number {
    const song = this.transport.loopBeats();
    // A shorter song loop is exported exactly, so the file loops cleanly.
    if (song < SONG_BEATS) return song;
    const spb = 60 / this.transport.bpm();
    const ends = this.transport.tracks().flatMap((t) => {
      const content = t.notes.length + t.takes.length > 0;
      // A track looping inside the song fills it to the end.
      if (content && this.transport.trackLoop(t) < song) return [song];
      return [
        ...t.notes.map((n) => n.start + n.length),
        ...t.takes.map((k) => k.start + k.duration / spb),
      ];
    });
    const last = Math.max(0, ...ends);
    const bars = Math.max(4, Math.ceil(last / BEATS_PER_BAR) + 1);
    return Math.min(song, bars * BEATS_PER_BAR);
  }

  /** Plays the song once from the top while recording MAIN, then downloads the WAV. Again cancels. */
  async exportMix() {
    if (this.exporting() !== null) return this.cancelExport?.();
    this.engine.start();
    if (!this.engine.running()) {
      this.store.flash('turn AUDIO on to export the mix');
      return;
    }
    if (this.transport.recording()) this.transport.record();
    if (this.transport.playing()) this.transport.stop();
    const beats = this.songBeats();
    this.exporting.set(0);
    let cancelled = false;
    this.cancelExport = () => (cancelled = true);
    try {
      const capture = await this.engine.capture('main');
      this.transport.seek(0);
      this.transport.play();
      const a = this.anchor()!;
      const epoch = this.transport.epoch();
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const at = this.transport.beatNow();
          const wrapped = this.transport.epoch() !== epoch;
          if (cancelled || !this.transport.playing() || wrapped || at >= beats) {
            clearInterval(timer);
            resolve();
          } else this.exporting.set(at / beats);
        }, 50);
      });
      const stopped = !this.transport.playing();
      this.transport.stop();
      const { frame, chunks } = await capture.stop();
      if (cancelled || stopped) {
        this.store.flash('export cancelled');
        return;
      }
      const ctx = this.engine.context!;
      const sr = ctx.sampleRate;
      const channels = trimStart(joinChunks(chunks, 2), Math.round(a.time * sr) - frame).map((c) =>
        c.subarray(0, Math.round((beats * 60 * sr) / a.bpm)),
      );
      const url = URL.createObjectURL(new Blob([encodeWav(channels, sr)], { type: 'audio/wav' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'klinke-mix.wav';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.store.flash(`exported ${beats / BEATS_PER_BAR} bars → klinke-mix.wav`);
    } catch {
      this.store.flash("couldn't export the mix");
    } finally {
      this.exporting.set(null);
      this.cancelExport = undefined;
      this.transport.beats.set(0);
    }
  }
}
