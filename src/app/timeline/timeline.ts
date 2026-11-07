import { Component, computed, inject, signal } from '@angular/core';
import { GEAR } from '../core/gear';
import type { Note } from '../core/notes';
import { OFFSET_MAX, OFFSET_MIN } from '../core/metronome';
import { moveTake, recordedLength, trimTakeEnd, trimTakeStart, visiblePeaks } from '../core/takes';
import { BEATS_PER_BAR, SONG_BARS, SONG_BEATS, loopRepeats } from '../core/transport';
import { AudioEngine, playsNotes } from '../audio/audio-engine';
import { PatchStore } from '../patch-store';
import { Metronome } from '../metronome';
import { RecSettings } from '../rec-settings';
import { Recorder } from '../recorder';
import { Transport, type Take, type Track } from '../transport';

@Component({
  selector: 'kl-timeline',
  templateUrl: './timeline.html',
  styleUrl: './timeline.scss',
  host: { '[class.collapsed]': '!store.tracksOpen()' },
})
export class Timeline {
  protected readonly transport = inject(Transport);
  protected readonly store = inject(PatchStore);
  private readonly engine = inject(AudioEngine);
  protected readonly recorder = inject(Recorder);
  protected readonly rec = inject(RecSettings);
  /** Started here: the metronome clicks under the timeline it keeps time for. */
  private readonly metronome = inject(Metronome);
  protected readonly OFFSET_MIN = OFFSET_MIN;
  protected readonly OFFSET_MAX = OFFSET_MAX;
  /** The REC settings panel (click, count-in, latency): where it opens, or null when shut. */
  protected readonly recPanel = signal<{ left: number; top: number } | null>(null);
  /** The take picked on the timeline, to move, trim or delete. */
  protected readonly picked = signal<{ track: string; id: string } | null>(null);
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

  /** The song loop as bars, e.g. "1–16" or "5–8". */
  protected readonly loopLabel = computed(
    () => `${this.transport.loopStart() + 1}–${this.transport.loopBars()}`,
  );

  // ── Loop braces ───────────────────────────────────────

  /** The bar line nearest the pointer, 0–16, measured across `el` (the ruler or a lane). */
  private barAt(el: HTMLElement, clientX: number) {
    const r = el.getBoundingClientRect();
    return Math.min(SONG_BARS, Math.max(0, Math.round(((clientX - r.left) / r.width) * SONG_BARS)));
  }

  /** Follows a drag until the pointer lets go, calling `move` with each new pointer x. */
  private drag(e: PointerEvent, move: (x: number, m: PointerEvent) => void, end?: () => void) {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onMove = (m: PointerEvent) => move(m.clientX, m);
    const up = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      end?.();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** The song loop brace: drag an end to resize it, the middle to move it, in whole bars. */
  protected dragSongLoop(e: PointerEvent, part: 'start' | 'end' | 'move') {
    const ruler = (e.currentTarget as HTMLElement).closest('.ruler') as HTMLElement;
    const t = this.transport;
    const grab = this.barAt(ruler, e.clientX);
    const [s0, e0] = [t.loopStart(), t.loopBars()];
    this.drag(e, (x) => {
      const bar = this.barAt(ruler, x);
      if (part === 'start') t.setLoopWindow(Math.min(bar, e0 - 1), e0);
      else if (part === 'end') t.setLoopWindow(s0, Math.max(bar, s0 + 1));
      else {
        const shift = Math.min(SONG_BARS - e0, Math.max(-s0, bar - grab));
        t.setLoopWindow(s0 + shift, e0 + shift);
      }
    });
  }

  /**
   * A track's loop brace: drag its end to set how many bars the track repeats; dragged out to
   * the song loop's end (or past it) the track follows the song again.
   */
  protected dragTrackLoop(e: PointerEvent, t: Track) {
    const lane = (e.currentTarget as HTMLElement).closest('.lane') as HTMLElement;
    this.drag(e, (x) => {
      const bar = Math.max(1, this.barAt(lane, x));
      const loop = bar * BEATS_PER_BAR >= this.transport.loopBeats() ? 0 : bar;
      if (loop !== t.loop) this.transport.updateTrack(t.id, () => ({ loop }));
    });
  }

  protected clearTrackLoop(t: Track) {
    this.transport.updateTrack(t.id, () => ({ loop: 0 }));
  }

  /** The track's own loop is in force (it's shorter than the song loop). */
  protected looping(t: Track) {
    return this.transport.trackLoop(t) < this.transport.loopBeats();
  }

  protected trackLoopLabel(t: Track) {
    return this.looping(t) ? `${t.loop} BAR${t.loop > 1 ? 'S' : ''}` : 'SONG';
  }

  /** Where each repeat of a track starts (just [0] when it follows the song). */
  protected repeats(t: Track) {
    return loopRepeats(this.transport.trackLoop(t), this.transport.loopBeats());
  }

  protected pct(beats: number) {
    return (beats / SONG_BEATS) * 100;
  }

  /**
   * The ruler: click to move the playhead (snapped to the beat); drag along it to draw a new song
   * loop over the bars dragged across.
   */
  protected rulerDown(e: PointerEvent) {
    const ruler = e.currentTarget as HTMLElement;
    const r = ruler.getBoundingClientRect();
    const x0 = e.clientX;
    const from = this.barAt(ruler, x0);
    let drawing = false;
    this.drag(
      e,
      (x) => {
        if (!drawing && Math.abs(x - x0) < r.width / SONG_BARS / 2) return;
        drawing = true;
        const to = this.barAt(ruler, x);
        if (to !== from) this.transport.setLoopWindow(Math.min(from, to), Math.max(from, to));
      },
      () => {
        if (drawing) return;
        const beat = Math.floor(((x0 - r.left) / r.width) * SONG_BEATS);
        if (beat < this.transport.loopBeats()) this.transport.seek(beat);
      },
    );
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

  // ── Single takes ──────────────────────────────────────

  protected isPicked(t: Track, take: Take) {
    const p = this.picked();
    return !!p && p.track === t.id && p.id === take.id;
  }

  /**
   * Picks a take and drags it: its body moves it, its edges trim it (pulling an edge back out
   * brings the trimmed audio back). Moves snap to sixteenths; hold Shift to move freely.
   */
  protected takeDown(e: PointerEvent, t: Track, take: Take, part: 'move' | 'start' | 'end') {
    const lane = (e.currentTarget as HTMLElement).closest('.lane') as HTMLElement;
    (e.currentTarget as HTMLElement).closest<HTMLElement>('.take')?.focus();
    this.picked.set({ track: t.id, id: take.id });
    const r = lane.getBoundingClientRect();
    const beatAt = (x: number) => ((x - r.left) / r.width) * SONG_BEATS;
    const grab = beatAt(e.clientX);
    const spb = 60 / this.transport.bpm();
    const loop = this.transport.trackLoop(t);
    const full = recordedLength(take);
    const end = take.start + take.duration / spb;
    this.drag(e, (x, m) => {
      const snap = (b: number) => (m.shiftKey ? b : Math.round(b * 4) / 4);
      const d = beatAt(x) - grab;
      const next =
        part === 'move'
          ? moveTake(take, snap(take.start + d), loop, spb)
          : part === 'start'
            ? trimTakeStart(take, snap(take.start + d), spb)
            : trimTakeEnd(take, snap(end + d), full, loop, spb);
      this.recorder.updateTake(t.id, take.id, () => next);
    });
  }

  /** A picked take: Delete removes it, the arrows nudge it a sixteenth (Shift: a beat). */
  protected takeKey(e: KeyboardEvent, t: Track, take: Take) {
    const spb = 60 / this.transport.bpm();
    const step = e.shiftKey ? 1 : 0.25;
    if (e.key === 'Delete' || e.key === 'Backspace') this.removeTake(t, take);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const d = e.key === 'ArrowLeft' ? -step : step;
      const loop = this.transport.trackLoop(t);
      this.recorder.updateTake(t.id, take.id, (k) => moveTake(k, k.start + d, loop, spb));
    } else if (e.key === 'Escape') this.picked.set(null);
    else return;
    e.preventDefault();
    e.stopPropagation(); // not the floor's Delete (that removes gear)
  }

  protected removeTake(t: Track, take: Take) {
    this.recorder.removeTake(t.id, take.id);
    this.picked.set(null);
  }

  /** The part of the waveform that plays, as an SVG viewBox over the whole recording's peaks. */
  protected waveBox(take: Take) {
    const [a, b] = visiblePeaks(take);
    return `${a} 0 ${Math.max(1, b - a)} 100`;
  }

  // ── REC settings ──────────────────────────────────────

  protected toggleRecPanel(e: MouseEvent) {
    if (this.recPanel()) return this.recPanel.set(null);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Opens above the button (the timeline sits at the bottom of the screen).
    this.recPanel.set({ left: Math.max(8, r.left), top: r.top });
  }

  /** The latency the browser reports right now, in ms (for the panel). */
  protected measuredLatency() {
    const ctx = this.engine.context;
    if (!ctx) return null;
    return Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000);
  }

  protected setOffset(e: Event) {
    this.rec.update({ offsetMs: Number((e.target as HTMLInputElement).value) });
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
}
