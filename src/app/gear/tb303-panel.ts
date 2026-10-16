import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import type { Gear } from '../core/patch';
import {
  BASE_NOTE,
  NOTE_NAMES,
  PATTERNS,
  type Pattern,
  STEPS,
  type Step,
  type Time,
  emptyPattern,
  encodePattern,
  parseStatus,
  patternKey,
  patternsFromText,
  pitchFromNote,
  stepName,
} from '../core/tb303';
import { PatchStore } from '../patch-store';
import { Transport } from '../transport';
import { Knob } from './controls';

/** The sequencer's write modes; neither lit, the keys just play. */
type Mode = 'play' | 'pitch' | 'time';

/** The 13 keys C–C′: white keys on the bottom row, black ones above, as on the switch board. */
const WHITE = [0, 2, 4, 5, 7, 9, 11, 12];
const BLACK = [1, 3, 6, 8, 10];
/** In TIME MODE, DOWN / UP / ACCENT enter NOTE / TIE / REST. */
const TIME_OF: Record<'down' | 'up' | 'accent', Time> = { down: 'note', up: 'tie', accent: 'rest' };

/**
 * The TB-303's front panel, laid out like the silver original: the back-edge jacks; WAVEFORM
 * and the six knobs (TUNING, CUT OFF FREQ, RESONANCE, ENV MOD, DECAY, ACCENT) along the top;
 * tempo, the pattern selector, the logo and VOLUME; a display of the 16 steps; and the switch
 * board: RUN/STOP, PITCH MODE / TIME MODE, the C–C′ keys, DOWN / UP / ACCENT / SLIDE (NOTE /
 * TIE / REST in time mode), BACK, NEXT, CLEAR and LAST STEP.
 *
 * Writing a pattern: PITCH MODE, then for each step press DOWN / UP / ACCENT / SLIDE as wanted
 * and a key (or play one on the computer keyboard / MIDI); it is stored and the cursor moves on.
 * TIME MODE: NOTE / TIE / REST for each step. Click a step to move the cursor; LAST STEP ends the
 * pattern at the cursor.
 */
@Component({
  selector: 'kl-tb303-panel',
  imports: [Knob],
  templateUrl: './tb303-panel.html',
  styleUrl: './tb303-panel.scss',
})
export class Tb303Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly transport = inject(Transport);

  protected readonly WHITE = WHITE;
  protected readonly BLACK = BLACK;
  protected readonly NOTE_NAMES = NOTE_NAMES;
  protected readonly patternNumbers = Array.from({ length: PATTERNS }, (_, i) => i);
  protected readonly stepNumbers = Array.from({ length: STEPS }, (_, i) => i);

  protected readonly mode = signal<Mode>('play');
  protected readonly cursor = signal(0);
  /** DOWN / UP / ACCENT / SLIDE pressed for the next key written (or played). */
  protected readonly pendOct = signal(0);
  protected readonly pendAccent = signal(false);
  protected readonly pendSlide = signal(false);

  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  protected readonly bpm = computed(() => Math.round(this.transport.bpm()));
  private readonly status = computed(() => parseStatus(this.engine.statuses()[this.gear().id]));
  protected readonly running = computed(() => this.status().running);
  protected readonly playingStep = computed(() => this.status().step);

  private readonly patterns = computed(() => patternsFromText(this.gear().text));
  protected readonly patternIndex = computed(() =>
    Math.round(this.value('pattern') * (PATTERNS - 1)),
  );
  protected readonly pattern = computed(() => this.patterns()[this.patternIndex()]);
  protected readonly current = computed(() => this.pattern().steps[this.cursor()]);

  constructor() {
    // In PITCH MODE every note played by hand on this synth (keys here, the computer keyboard,
    // MIDI) is written to the step under the cursor.
    const off = this.engine.listen((id, note, on) => {
      if (on && id === this.gear().id && this.mode() === 'pitch' && !this.preview())
        this.writePitch(note);
    });
    inject(DestroyRef).onDestroy(off);
  }

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  // ── Display ───────────────────────────────────────────

  protected stepLabel(st: Step): string {
    return st.time === 'rest' ? '·' : st.time === 'tie' ? '—' : stepName(st);
  }

  protected stepTitle(i: number): string {
    const st = this.pattern().steps[i];
    const what =
      st.time === 'note'
        ? `${stepName(st)}${st.accent ? ' accent' : ''}${st.slide ? ' slide' : ''}`
        : st.time;
    return `Step ${i + 1}: ${what}`;
  }

  /** Key LEDs: the cursor step's key in PITCH MODE. */
  protected keyLit(pitch: number): boolean {
    return (
      this.mode() === 'pitch' && this.current().time !== 'rest' && this.current().pitch === pitch
    );
  }

  /** DOWN / UP / ACCENT / SLIDE LEDs: what's pressed for the next key, or in TIME MODE the step's time. */
  protected fnLit(fn: 'down' | 'up' | 'accent' | 'slide'): boolean {
    if (this.mode() === 'time') return fn !== 'slide' && this.current().time === TIME_OF[fn];
    if (fn === 'down') return this.pendOct() < 0;
    if (fn === 'up') return this.pendOct() > 0;
    return fn === 'accent' ? this.pendAccent() : this.pendSlide();
  }

  // ── Switch board ──────────────────────────────────────

  protected run() {
    if (!this.preview()) this.engine.command(this.gear().id, 'run');
  }

  protected setMode(m: Exclude<Mode, 'play'>) {
    this.mode.update((cur) => (cur === m ? 'play' : m));
  }

  protected selectStep(i: number) {
    this.cursor.set(i);
  }

  protected selectPattern(i: number) {
    this.set('pattern', i / (PATTERNS - 1));
    this.cursor.set(0);
  }

  /** A C–C′ key: plays (and in PITCH MODE writes, via the note listener) at DOWN / UP's octave. */
  protected keyDown(e: PointerEvent, pitch: number) {
    e.stopPropagation();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const id = this.gear().id;
    this.store.selected.set(id); // the computer keyboard now plays this synth too
    const note = BASE_NOTE + this.pendOct() * 12 + pitch;
    this.engine.noteOn(note, id);
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      this.engine.noteOff(note, id);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** DOWN / UP / ACCENT / SLIDE: in TIME MODE the first three are NOTE / TIE / REST. */
  protected fn(name: 'down' | 'up' | 'accent' | 'slide') {
    if (this.mode() === 'time') {
      if (name !== 'slide') this.writeTime(TIME_OF[name]);
      return;
    }
    if (name === 'down') this.pendOct.update((o) => (o < 0 ? 0 : -1));
    else if (name === 'up') this.pendOct.update((o) => (o > 0 ? 0 : 1));
    else if (name === 'accent') this.pendAccent.update((a) => !a);
    else this.pendSlide.update((sl) => !sl);
  }

  protected back() {
    const n = this.pattern().length;
    this.cursor.update((c) => (c - 1 + n) % n);
  }

  protected next() {
    this.cursor.update((c) => (c + 1) % this.pattern().length);
  }

  protected clear() {
    this.save(emptyPattern());
    this.cursor.set(0);
  }

  /** LAST STEP: the pattern ends at the cursor. */
  protected lastStep() {
    this.save({ ...this.pattern(), length: this.cursor() + 1 });
  }

  // ── Writing ───────────────────────────────────────────

  private writePitch(note: number) {
    const { pitch, oct } = pitchFromNote(note);
    const st = this.current();
    this.writeStep({
      pitch,
      oct,
      accent: this.pendAccent(),
      slide: this.pendSlide(),
      time: st.time === 'rest' ? 'note' : st.time,
    });
    this.pendOct.set(0);
    this.pendAccent.set(false);
    this.pendSlide.set(false);
  }

  private writeTime(time: Time) {
    this.writeStep({ ...this.current(), time });
  }

  /** Stores the step under the cursor and moves on, wrapping at the pattern's end. */
  private writeStep(st: Step) {
    if (this.preview()) return;
    const pat = this.pattern();
    const i = this.cursor();
    this.save({ ...pat, steps: pat.steps.map((s, j) => (j === i ? st : s)) });
    this.cursor.set((i + 1) % pat.length);
  }

  private save(pat: Pattern) {
    if (this.preview()) return;
    this.store.setText(this.gear().id, patternKey(this.patternIndex()), encodePattern(pat));
  }
}
