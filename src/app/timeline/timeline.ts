import { Component, computed, inject } from '@angular/core';
import { GEAR } from '../core/gear';
import type { Note } from '../core/notes';
import { LOOP_BARS, SONG_BARS, SONG_BEATS, loopRepeats } from '../core/transport';
import { AudioEngine, playsNotes } from '../audio/audio-engine';
import { PatchStore } from '../patch-store';
import { Recorder } from '../recorder';
import { Transport, type Take, type Track } from '../transport';

@Component({
  selector: 'kl-timeline',
  templateUrl: './timeline.html',
  styleUrl: './timeline.scss',
})
export class Timeline {
  protected readonly transport = inject(Transport);
  private readonly store = inject(PatchStore);
  private readonly engine = inject(AudioEngine);
  protected readonly recorder = inject(Recorder);
  protected readonly bars = Array.from({ length: SONG_BARS }, (_, i) => i + 1);
  protected readonly flags = [
    { key: 'arm', label: 'R', title: 'Record arm' },
    { key: 'mute', label: 'M', title: 'Mute' },
    { key: 'solo', label: 'S', title: 'Solo' },
  ] as const;
  protected readonly playhead = computed(() => (this.transport.beats() / SONG_BEATS) * 100);
  /** Gear a MIDI track can play: the synths, the SP-1200 and the note effects. */
  protected readonly instruments = computed(() =>
    this.store
      .patch()
      .gear.filter((g) => playsNotes(g.kind))
      .map((g) => ({ id: g.id, label: GEAR[g.kind].label })),
  );

  /** What an audio track can record: the mix, or any one piece of gear's audio OUT. */
  protected readonly sources = computed(() => [
    { id: 'main', label: 'MAIN MIX' },
    ...this.store
      .patch()
      .gear.filter(
        (g) => g.kind !== 'output' && GEAR[g.kind].jacks.some((j) => j.dir === 'out' && !j.signal),
      )
      .map((g) => ({ id: g.id, label: `${GEAR[g.kind].label} (${g.id})` })),
  ]);
  private readonly waves = new Map<string, string>();

  /** Song loop slider positions: 1, 2, 4, 8, 16 bars. */
  protected readonly LOOP_BARS = LOOP_BARS;
  /** Track loop slider positions: OFF (follow the song), then 1, 2, 4, 8 bars. */
  protected readonly TRACK_LOOPS = [0, 1, 2, 4, 8];
  protected readonly songLoopIndex = computed(() =>
    LOOP_BARS.indexOf(this.transport.loopBars() as (typeof LOOP_BARS)[number]),
  );

  protected setSongLoop(e: Event) {
    this.transport.setLoop(LOOP_BARS[Number((e.target as HTMLInputElement).value)]);
  }

  protected setTrackLoop(t: Track, e: Event) {
    const loop = this.TRACK_LOOPS[Number((e.target as HTMLInputElement).value)];
    this.transport.updateTrack(t.id, () => ({ loop }));
  }

  /** The track's own loop is in force (it's shorter than the song loop). */
  protected looping(t: Track) {
    return this.transport.trackLoop(t) < this.transport.loopBeats();
  }

  protected trackLoopLabel(t: Track) {
    if (!t.loop) return 'OFF';
    return this.looping(t) ? `${t.loop} BAR${t.loop > 1 ? 'S' : ''}` : 'SONG';
  }

  /** Where each repeat of a track starts (just [0] when it follows the song). */
  protected repeats(t: Track) {
    return loopRepeats(this.transport.trackLoop(t), this.transport.loopBeats());
  }

  protected pct(beats: number) {
    return (beats / SONG_BEATS) * 100;
  }

  /** Click the ruler to move the playhead, snapped to the beat. */
  protected seek(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const beat = Math.floor(((e.clientX - r.left) / r.width) * SONG_BEATS);
    if (beat < this.transport.loopBeats()) this.transport.seek(beat);
  }

  protected toggleType(t: Track) {
    const next = t.type === 'midi' ? 'audio' : 'midi';
    this.transport.setType(
      t.id,
      next,
      this.engine.keyboardSynth() ?? this.instruments()[0]?.id ?? null,
    );
    if (next === 'midi') this.open(t);
  }

  /** Opens a MIDI track in the piano roll and gives its instrument the keyboard. */
  protected open(t: Track) {
    if (t.type !== 'midi') return;
    this.transport.openTrack.set(t.id);
    if (t.instrument) this.store.selected.set(t.instrument);
  }

  protected setInstrument(t: Track, e: Event) {
    const id = (e.target as HTMLSelectElement).value || null;
    this.transport.updateTrack(t.id, () => ({ instrument: id }));
    if (id) this.store.selected.set(id);
  }

  /** Mini piano-roll rows: each note's vertical position within the track's pitch range, 0–100 %. */
  protected noteTop(t: Track, n: Note) {
    const lo = Math.min(...t.notes.map((x) => x.note));
    const hi = Math.max(...t.notes.map((x) => x.note));
    return hi === lo ? 45 : ((hi - n.note) / (hi - lo)) * 80 + 5;
  }

  protected setSource(t: Track, e: Event) {
    const source = (e.target as HTMLSelectElement).value;
    this.transport.updateTrack(t.id, () => ({ source }));
  }

  protected sourceLabel(t: Track) {
    return this.sources().find((s) => s.id === t.source)?.label ?? 'UNPLUGGED GEAR';
  }

  /** A take's length on the timeline at the current tempo. */
  protected takeBeats(t: Track, take: Take) {
    return Math.min(
      this.transport.trackLoop(t) - take.start,
      (take.duration * this.transport.bpm()) / 60,
    );
  }

  protected noteBeats(t: Track, n: Note) {
    return Math.min(n.length, this.transport.trackLoop(t) - n.start);
  }

  /** Notes inside the track's loop (later ones never play while it loops). */
  protected loopNotes(t: Track) {
    const loop = this.transport.trackLoop(t);
    return t.notes.filter((n) => n.start < loop);
  }

  /** The take's waveform as one SVG path: a vertical line per peak, in a 100-tall box. */
  protected wave(take: Take) {
    let d = this.waves.get(take.id);
    if (d === undefined) {
      d = take.peaks
        .map((p, i) => `M${i} ${(50 - p * 48).toFixed(1)}V${(50 + p * 48).toFixed(1)}`)
        .join('');
      this.waves.set(take.id, d);
    }
    return d;
  }

  protected liveStart(t: Track): number | undefined {
    return this.recorder.live()[t.id];
  }

  protected clear(t: Track) {
    if (
      confirm(
        `Delete ${t.takes.length === 1 ? 'the take' : `all ${t.takes.length} takes`} on ${t.name}?`,
      )
    )
      this.recorder.clearTakes(t);
  }

  protected instrumentLabel(t: Track) {
    return this.instruments().find((i) => i.id === t.instrument)?.label ?? 'NO INSTRUMENT';
  }
}
