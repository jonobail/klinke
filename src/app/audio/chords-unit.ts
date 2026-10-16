// CHORD-8: turns each key into a chord and plays it out of NOTE OUT through the player FX. It
// makes no sound. Every held key (or pad button) is a "hit" with its own chord, timers and
// voices, so several chords can sound at once and each stops on its own key's release.
//
//   key ─┬─ PADS mode: white keys from the base C → pads 1–8 (the stored progression)
//        └─ SCALE mode (and while REC is armed): snapped to the scale → that degree's chord
//   chord → ARP (if on) / PATTERN (if on) / one strummed hit + BOUNCE repeats → NOTE OUT
//
// Events go out the moment they're emitted, so timing is done by emitting at the right moment:
// one setTimeout per event, the arp and pattern clocks counting from their start (no drift).
// The per-note BEND slides run on a 20 ms ticker as 'expr' events.

import {
  type ChordsSettings,
  DEFAULT_PROGRESSION,
  GEN_PATTERN,
  PATTERN_PRESETS,
  type Pad,
  arpOrder,
  arpStepMs,
  bounceTimes,
  buildChord,
  chordsSettings,
  formatProgression,
  formatStatus,
  generatePattern,
  generateProgression,
  padForStep,
  parsePattern,
  parseProgression,
  rng,
  sixteenthMs,
  slideAt,
  snapToScale,
  stepsToNext,
  strumOffsets,
} from '../core/chords';
import { type NoteEvent, type Params, type Playable, Unit } from './unit';

const SLIDE_MS = 20;
/** Keys from a NOTE IN cable count steps from C3, like the on-screen keyboard's default base. */
const IN_BASE = 48;

type Timer = ReturnType<typeof setTimeout>;

interface Hit {
  pad: number | null;
  notes: number[];
  velocity: number;
  timers: Set<Timer>;
  voices: Set<number>;
  /** Chords played so far (ALT strum alternates on it). */
  count: number;
}

interface Voice {
  note: number;
  /** BEND: where the slide starts (semitones) and when, by `performance.now()`. */
  from: number;
  start: number;
  time: number;
}

export class ChordsUnit extends Unit implements Playable {
  private s!: ChordsSettings;
  private bpm = 120;
  private pads: Pad[] = DEFAULT_PROGRESSION;
  private genPattern = '';
  /** Held hits by key: a MIDI note, or -1 − n for pad button n. */
  private readonly hits = new Map<number, Hit>();
  private readonly voices = new Map<number, Voice>();
  /** NOTE IN voices → the key they hold. */
  private readonly inVoices = new Map<number, number>();
  private nextVoice = 1;
  private wheel = 0;
  private prev: number[] | null = null;
  private chordName = '';
  /** Next pad REC writes, or -1. */
  private rec = -1;
  private slider?: ReturnType<typeof setInterval>;

  set(p: Params) {
    this.s = chordsSettings(p);
  }

  override setTempo(bpm: number) {
    this.bpm = bpm;
  }

  override setText(text: Record<string, string>) {
    this.pads = parseProgression(text['prog']) ?? DEFAULT_PROGRESSION;
    this.genPattern = text['gen'] ?? '';
  }

  override status() {
    const lit = new Set<number>();
    for (const h of this.hits.values()) if (h.pad !== null) lit.add(h.pad);
    return formatStatus({ chord: this.chordName, lit: [...lit], rec: this.rec });
  }

  override command(name: string) {
    if (name === 'dice') this.dice();
    else if (name === 'rec') this.rec = this.rec < 0 ? 0 : -1;
    else {
      // Pad buttons: "pad:3:on" / "pad:3:off".
      const [kind, n, state] = name.split(':');
      if (kind !== 'pad') return;
      if (state === 'on') this.playPad(-1 - Number(n), Number(n), this.s.velocity);
      else this.release(-1 - Number(n));
    }
  }

  /** DICE: a new progression (and PATTERN GEN rhythm) in the current style, saved with the patch. */
  private dice() {
    const r = rng((Math.random() * 2 ** 32) >>> 0);
    this.pads = generateProgression(this.s.style, r);
    this.genPattern = generatePattern(this.s.style, r);
    this.saveText?.('prog', formatProgression(this.pads));
    this.saveText?.('gen', this.genPattern);
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number, step: number) {
    this.press(note, step, this.s.velocity);
  }

  noteOff(note: number) {
    this.release(note);
  }

  override receive(_jack: string, e: NoteEvent) {
    if (e.type === 'on') {
      this.inVoices.set(e.voice, e.note);
      this.press(e.note, e.note - IN_BASE, this.s.velocity * (e.velocity ?? 1));
    } else if (e.type === 'off') {
      const note = this.inVoices.get(e.voice);
      if (note === undefined) return;
      this.inVoices.delete(e.voice);
      this.release(note);
    }
  }

  allNotesOff() {
    for (const key of [...this.hits.keys()]) this.release(key);
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
    this.inVoices.clear();
  }

  /** The pitch wheel bends every chord note by ±2 semitones, on top of its slide. */
  pitchBend(amount: number) {
    this.wheel = amount * 2;
    const now = performance.now();
    for (const [id, v] of this.voices) this.expr(id, v, now);
  }

  private press(key: number, step: number, velocity: number) {
    this.release(key);
    if (this.rec >= 0 || this.s.mode === 'scale') {
      const snap = snapToScale(key, this.s.key, this.s.scale);
      const size = this.s.size || 1;
      // REC writes each chord played onto the next pad, then disarms after pad 8.
      let pad: number | null = null;
      if (this.rec >= 0) {
        pad = this.rec;
        this.pads = this.pads.map((d, i) =>
          i === pad ? { degree: ((snap.degree % 7) + 7) % 7, size } : d,
        );
        this.saveText?.('prog', formatProgression(this.pads));
        this.rec = this.rec >= 7 ? -1 : this.rec + 1;
      }
      this.start(key, pad, buildChord(this.s, snap.degree, size, this.prev, snap.note), velocity);
      return;
    }
    const pad = padForStep(step);
    if (pad !== null) this.playPad(key, pad, velocity);
  }

  private playPad(key: number, pad: number, velocity: number) {
    this.release(key);
    const d = this.pads[pad];
    this.start(key, pad, buildChord(this.s, d.degree, d.size, this.prev), velocity);
  }

  private release(key: number) {
    const hit = this.hits.get(key);
    if (!hit) return;
    for (const t of hit.timers) clearTimeout(t);
    for (const id of hit.voices) this.stopVoice(id);
    this.hits.delete(key);
  }

  // ── Player ────────────────────────────────────────────

  private start(
    key: number,
    pad: number | null,
    chord: { notes: number[]; name: string },
    velocity: number,
  ) {
    const hit: Hit = {
      pad,
      notes: chord.notes,
      velocity,
      timers: new Set(),
      voices: new Set(),
      count: 0,
    };
    this.hits.set(key, hit);
    this.prev = chord.notes;
    this.chordName = chord.name;
    const s = this.s;
    if (s.arp !== 'off') this.arp(hit);
    else if (s.pattern > 0) this.pattern(hit);
    else {
      this.chord(hit, velocity, null);
      for (const b of bounceTimes(s.bounce, s.bounceGap))
        this.later(hit, b.at, () => {
          for (const id of hit.voices) this.stopVoice(id);
          hit.voices.clear();
          this.chord(hit, velocity * b.level, null);
        });
    }
  }

  /** ARP: one step per rate, counted from the start so the clock never drifts. */
  private arp(hit: Hit) {
    let k = 0;
    let at = performance.now();
    const step = () => {
      const s = this.s;
      if (s.arp === 'off') return;
      const ms = arpStepMs(s.arpRate, this.bpm);
      const order = arpOrder(hit.notes, s.arp, s.arpOctaves);
      const notes =
        s.arp === 'random'
          ? order[Math.floor(Math.random() * order.length)]
          : order[k % order.length];
      if (notes.length > 1) this.chord(hit, hit.velocity, ms * s.gate, notes);
      else this.note(hit, notes[0], hit.velocity, ms * s.gate);
      k++;
      at += ms;
      this.later(hit, at - performance.now(), step);
    };
    step();
  }

  /** PATTERN: the chord retriggered on the pattern's sixteenths, accents louder. */
  private pattern(hit: Hit) {
    let i = 0;
    let at = performance.now();
    const step = () => {
      const s = this.s;
      if (s.pattern === 0) return;
      const steps = parsePattern(
        s.pattern === GEN_PATTERN
          ? this.genPattern || generatePattern(s.style, rng(1))
          : PATTERN_PRESETS[s.pattern].steps,
      );
      const ms = sixteenthMs(this.bpm);
      if (steps[i] > 0)
        this.chord(hit, hit.velocity * steps[i], ms * stepsToNext(steps, i) * s.gate);
      i = (i + 1) % 16;
      at += ms;
      this.later(hit, at - performance.now(), step);
    };
    step();
  }

  /** Plays the chord, strummed; `length` ends each note (null holds it until the key is let go). */
  private chord(hit: Hit, velocity: number, length: number | null, notes = hit.notes) {
    const offsets = strumOffsets(notes.length, this.s.strum, this.s.strumDir, hit.count++);
    notes.forEach((n, i) => {
      if (offsets[i] <= 0) this.note(hit, n, velocity, length);
      else this.later(hit, offsets[i], () => this.note(hit, n, velocity, length));
    });
  }

  private note(hit: Hit, note: number, velocity: number, length: number | null) {
    const id = this.startVoice(note, velocity);
    hit.voices.add(id);
    if (length !== null)
      this.later(hit, length, () => {
        hit.voices.delete(id);
        this.stopVoice(id);
      });
  }

  private later(hit: Hit, ms: number, fn: () => void) {
    const t = setTimeout(
      () => {
        hit.timers.delete(t);
        fn();
      },
      Math.max(0, ms),
    );
    hit.timers.add(t);
  }

  // ── Voices ────────────────────────────────────────────

  private startVoice(note: number, velocity: number): number {
    const id = this.nextVoice++;
    const v: Voice = { note, from: this.s.bend, start: performance.now(), time: this.s.bendTime };
    this.voices.set(id, v);
    const vel = Math.min(1, Math.max(0.01, velocity));
    this.emit({ type: 'on', voice: id, note, velocity: vel, bend: v.from + this.wheel });
    if (v.from !== 0) this.slider ??= setInterval(() => this.slide(), SLIDE_MS);
    return id;
  }

  private stopVoice(id: number) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    this.emit({ type: 'off', voice: id, note: v.note });
  }

  private expr(id: number, v: Voice, now: number) {
    this.emit({
      type: 'expr',
      voice: id,
      note: v.note,
      bend: slideAt(now - v.start, v.from, v.time) + this.wheel,
    });
  }

  /** BEND: moves every sliding voice toward its note; the ticker stops when none are left. */
  private slide() {
    const now = performance.now();
    let sliding = false;
    for (const [id, v] of this.voices) {
      if (v.from === 0) continue;
      this.expr(id, v, now);
      if (now - v.start >= v.time) v.from = 0;
      else sliding = true;
    }
    if (!sliding) {
      clearInterval(this.slider);
      this.slider = undefined;
    }
  }

  override dispose() {
    this.allNotesOff();
    clearInterval(this.slider);
    super.dispose();
  }
}
