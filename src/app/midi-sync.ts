import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import {
  CLOCK,
  ClockLine,
  type MidiSettings,
  PPQN,
  STOP,
  TempoEstimator,
  loopDiff,
  parseMidiSettings,
  sppBeats,
  sppBytes,
  startPoint,
  tempoMoved,
} from './core/midi-clock';
import { type MidiEvent } from './core/sound';
import { Transport } from './transport';

const MIDI_KEY = 'klinke.midi.v1';
/** The clock scheduler wakes this often (ms)… */
const PUMP_MS = 25;
/** …and books ticks this far ahead (ms), longer in a background tab where timers slow down. */
const AHEAD_MS = 100;
const AHEAD_HIDDEN_MS = 1500;
/** Clock out follows a song-position change this small (beats) by bending, not restarting. */
const JUMP = 1 / 8;
/** Clock in nudges the song once it drifts this far (beats) from the ticks. */
const DRIFT = 1 / 96;
/** A song-clock anchor this recent (ms) is where clock out starts from. */
const FRESH_MS = 50;

/**
 * MIDI clock out (24 a beat, START / CONTINUE / STOP and song position to the chosen outputs)
 * and clock in (the song follows another device's clock and transport).
 *
 * Out: ticks are booked ahead with `MIDIOutput.send(data, time)` so they stay steady whatever
 * the page is doing. Round the song loop the clock just keeps going (most gear only follows the
 * clock; a pattern a power of two bars long stays in step); a seek while playing sends STOP,
 * the new song position and CONTINUE, which is what gear that follows song position expects.
 *
 * In: START plays from the top on the next tick, CONTINUE from where the song is, STOP stops,
 * song position seeks. The tempo comes from the tick intervals and the song is nudged back in
 * step with the ticks every beat.
 */
@Injectable({ providedIn: 'root' })
export class MidiSync {
  private readonly engine = inject(AudioEngine);
  private readonly transport = inject(Transport);

  readonly settings = signal<MidiSettings>(load());
  /** The song's tempo and transport follow MIDI clock in. */
  readonly external = computed(() => this.settings().sync === 'external');

  // Clock out
  private line: ClockLine | null = null;
  private timer?: ReturnType<typeof setInterval>;

  // Clock in
  private readonly tempo = new TempoEstimator();
  /** START or CONTINUE came in: the next tick sets the song going. */
  private armed = false;
  /** Following the clock (between START / CONTINUE and STOP). */
  private following = false;
  /** Song position of the next tick, in beats. */
  private nextBeat = 0;
  private ticks = 0;

  constructor() {
    effect(() => {
      const s = this.settings();
      try {
        localStorage.setItem(MIDI_KEY, JSON.stringify(s));
      } catch {
        // Private mode or full storage: the settings just won't outlast the page.
      }
    });

    // Clock out follows play / stop and every jump or re-anchor of the song clock.
    effect(() => {
      const on = this.settings().clockOut && !!this.engine.midiAccess();
      const playing = this.transport.playing();
      this.transport.epoch();
      untracked(() => this.updateOut(on, playing));
    });

    // Stopped, the song position goes out whenever it moves.
    const parked = computed(() =>
      this.transport.playing() ? null : startPoint(this.transport.beats()).spp,
    );
    effect(() => {
      const spp = parked();
      if (spp !== null && this.settings().clockOut && this.engine.midiAccess())
        untracked(() => this.send(sppBytes(spp)));
    });

    // Back on the internal clock: forget the external one.
    effect(() => {
      if (!this.external()) untracked(() => this.resetIn());
    });

    this.engine.onMidi((msg, input, time) => this.heard(msg, input, time));
  }

  update(change: Partial<MidiSettings>) {
    this.settings.update((s) => ({ ...s, ...change }));
  }

  // ── Clock out ─────────────────────────────────────────

  private updateOut(on: boolean, playing: boolean) {
    if (!on || !playing) {
      if (this.line) this.halt();
      return;
    }
    if (!this.line) return this.begin();
    // Re-anchored (a tempo change, the loop wrapping) or jumped (a seek)?
    const now = performance.now();
    const at = this.line.beatAt(now);
    const d = loopDiff(this.transport.beatNow(), at, this.transport.loopBeats());
    if (Math.abs(d) < JUMP) this.line.reanchor(at + d, now, this.transport.bpm());
    else {
      this.halt();
      this.begin();
    }
  }

  /** Song position, then START or CONTINUE on the next sixteenth, then the ticks. */
  private begin() {
    let now = performance.now();
    let beat = this.transport.beatNow();
    // Just pressed PLAY (or seeked): start from that very moment, so from the top is START.
    const anchor = this.transport.anchor();
    if (now - anchor.time < FRESH_MS) ({ beat, time: now } = anchor);
    const bpm = this.transport.bpm();
    const p = startPoint(beat);
    const at = now + ((p.beat - beat) * 60000) / bpm;
    this.send(sppBytes(p.spp), now);
    this.send([p.message], at);
    this.line = new ClockLine(p.beat, at, bpm);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), PUMP_MS);
    this.pump();
  }

  private halt() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.line = null;
    for (const o of this.outputs()) {
      try {
        // Drop ticks booked ahead (where the browser can), then STOP straight away.
        (o as MIDIOutput & { clear?: () => void }).clear?.();
      } catch {
        // Not supported: the few booked ticks go out after STOP, which gear ignores.
      }
    }
    this.send([STOP]);
  }

  private pump() {
    if (!this.line) return;
    const ahead = document.hidden ? AHEAD_HIDDEN_MS : AHEAD_MS;
    for (const t of this.line.take(performance.now() + ahead)) this.send([CLOCK], t);
  }

  private outputs(): MIDIOutput[] {
    const access = this.engine.midiAccess();
    const want = this.settings().output;
    const out: MIDIOutput[] = [];
    access?.outputs.forEach((o) => {
      if (o.state !== 'disconnected' && (!want || o.name === want)) out.push(o);
    });
    return out;
  }

  private send(data: number[], time?: number) {
    for (const o of this.outputs()) {
      try {
        o.send(data, time);
      } catch {
        // A port that went away mid-send.
      }
    }
  }

  // ── Clock in ──────────────────────────────────────────

  private heard(msg: MidiEvent, input: string, time: number) {
    const s = this.settings();
    if (s.sync !== 'external' || (s.input && s.input !== input)) return;
    switch (msg.type) {
      case 'clock':
        return this.tick(time);
      case 'start':
        if (this.transport.playing()) this.transport.stop();
        this.transport.seek(0);
        this.nextBeat = 0;
        this.armed = true;
        this.following = false;
        return;
      case 'continue':
        if (this.following) return;
        this.nextBeat = this.transport.beatNow();
        this.armed = true;
        return;
      case 'stop':
        this.armed = this.following = false;
        if (this.transport.playing()) this.transport.stop();
        return;
      case 'position': {
        const beat = sppBeats(msg.sixteenths) % this.transport.loopBeats();
        this.nextBeat = beat;
        if (!this.following) this.transport.seek(beat);
        return;
      }
    }
  }

  private tick(time: number) {
    this.tempo.push(time);
    const beat = this.nextBeat;
    this.nextBeat += 1 / PPQN;
    if (this.armed) {
      // The first tick after START / CONTINUE is the downbeat it starts from.
      this.armed = false;
      this.following = true;
      this.ticks = -1; // so beats are counted from this one
      if (!this.transport.playing()) this.transport.play();
      this.transport.syncTo(beat, time);
    }
    if (++this.ticks % PPQN) return;
    // Once a beat: keep the song on the ticks, then the tempo.
    if (this.following && this.transport.playing()) {
      const loop = this.transport.loopBeats();
      const there =
        this.transport.beatNow() - ((performance.now() - time) * this.transport.bpm()) / 60000;
      if (Math.abs(loopDiff(there, beat, loop)) > DRIFT) this.transport.syncTo(beat, time);
    }
    const bpm = this.tempo.bpm();
    if (bpm !== null && tempoMoved(this.transport.bpm(), bpm)) this.transport.setBpm(bpm);
  }

  private resetIn() {
    this.tempo.reset();
    this.armed = this.following = false;
    this.ticks = 0;
  }
}

function load(): MidiSettings {
  try {
    return parseMidiSettings(JSON.parse(localStorage.getItem(MIDI_KEY) ?? 'null'));
  } catch {
    return parseMidiSettings(null);
  }
}
