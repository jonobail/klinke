import { Component, computed, inject } from '@angular/core';
import { GEAR } from '../core/gear';
import type { Note } from '../core/notes';
import { SONG_BARS, SONG_BEATS } from '../core/transport';
import { AudioEngine } from '../audio/audio-engine';
import { PatchStore } from '../patch-store';
import { Transport, type Track } from '../transport';

@Component({
  selector: 'kl-timeline',
  templateUrl: './timeline.html',
  styleUrl: './timeline.scss',
})
export class Timeline {
  protected readonly transport = inject(Transport);
  private readonly store = inject(PatchStore);
  private readonly engine = inject(AudioEngine);
  protected readonly bars = Array.from({ length: SONG_BARS }, (_, i) => i + 1);
  protected readonly flags = [
    { key: 'arm', label: 'R', title: 'Record arm' },
    { key: 'mute', label: 'M', title: 'Mute' },
    { key: 'solo', label: 'S', title: 'Solo' },
  ] as const;
  protected readonly playhead = computed(() => (this.transport.beats() / SONG_BEATS) * 100);
  /** Gear a MIDI track can play: the synths and the SP-1200. */
  protected readonly instruments = computed(() =>
    this.store
      .patch()
      .gear.filter((g) => GEAR[g.kind].category === 'synth')
      .map((g) => ({ id: g.id, label: GEAR[g.kind].label })),
  );

  protected pct(beats: number) {
    return (beats / SONG_BEATS) * 100;
  }

  /** Click the ruler to move the playhead, snapped to the beat. */
  protected seek(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.transport.seek(Math.floor(((e.clientX - r.left) / r.width) * SONG_BEATS));
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

  protected instrumentLabel(t: Track) {
    return this.instruments().find((i) => i.id === t.instrument)?.label ?? 'NO INSTRUMENT';
  }
}
