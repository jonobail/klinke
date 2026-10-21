import { Component, computed, inject, input, signal } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import type { Gear } from '../core/patch';
import {
  INSTRUMENTS,
  INSTRUMENT_NAMES,
  type Instrument,
  LOCATIONS,
  type Pattern,
  SCALE_NAMES,
  SOUND_NOTES,
  STEPS,
  bit,
  emptyPattern,
  encodeChain,
  encodePattern,
  parseChain,
  parseStatus,
  patternIndex,
  patternKey,
  patternsFromText,
  pressLocation,
  setStep,
  toggleStep,
} from '../core/tr606';
import { PatchStore } from '../patch-store';
import { Transport } from '../transport';
import { Knob } from './controls';

type Mode = 'write' | 'play';

/**
 * The TR-606's front panel: the back-edge jacks; TEMPO, ACCENT, the five instrument levels and
 * VOLUME along the top; the MODE switch (PATTERN WRITE / PATTERN PLAY), PATTERN GROUP I / II,
 * the instrument selector and SCALE; then CLEAR, LAST STEP, TAP, RUN/STOP and the 16 step keys.
 *
 * PATTERN PLAY: a step key picks the pattern at that location; shift-click chains locations in
 * the same block of four. PATTERN WRITE: the step keys turn the selected instrument on and off
 * on each step of the first pattern in the chain; TAP writes it on the step playing.
 */
@Component({
  selector: 'kl-tr606-panel',
  imports: [Knob],
  templateUrl: './tr606-panel.html',
  styleUrl: './tr606-panel.scss',
})
export class Tr606Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly transport = inject(Transport);

  protected readonly INSTRUMENTS = INSTRUMENTS;
  protected readonly INSTRUMENT_NAMES = INSTRUMENT_NAMES;
  protected readonly SCALE_NAMES = SCALE_NAMES;
  protected readonly stepNumbers = Array.from({ length: STEPS }, (_, i) => i);
  protected readonly levels = [
    ['accent', 'ACCENT'],
    ['bd', 'BD'],
    ['sd', 'SD'],
    ['tom', 'LT · HT'],
    ['cy', 'CY'],
    ['hh', 'OH · CH'],
  ];

  protected readonly mode = signal<Mode>('write');
  protected readonly instrument = signal<Instrument>('BD');
  /** LAST STEP pressed: the next step key sets the pattern's length. */
  protected readonly settingLast = signal(false);

  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  protected readonly bpm = computed(() => Math.round(this.transport.bpm()));
  private readonly status = computed(() => parseStatus(this.engine.statuses()[this.gear().id]));
  protected readonly running = computed(() => this.status().running);
  protected readonly playingStep = computed(() => this.status().step);

  protected readonly group = computed(() => Math.round(this.value('group')));
  protected readonly chain = computed(() => parseChain(this.gear().text?.['chain']));
  private readonly patterns = computed(() => patternsFromText(this.gear().text));
  /** The pattern being written: the first in the chain. */
  protected readonly editIndex = computed(() => patternIndex(this.group(), this.chain()[0]));
  protected readonly pattern = computed(() => this.patterns()[this.editIndex()]);
  /** The location playing in this group, or −1. */
  protected readonly playingLocation = computed(() => {
    const p = this.status().pattern;
    return p >= 0 && Math.floor(p / LOCATIONS) === this.group() ? p % LOCATIONS : -1;
  });

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  // ── Step keys ─────────────────────────────────────────

  /** A step key's LED: in WRITE the selected instrument on that step, in PLAY the chain. */
  protected lit(i: number): boolean {
    if (this.mode() === 'play') return this.chain().includes(i);
    return (this.pattern().steps[i] & bit(this.instrument())) !== 0;
  }

  protected stepTitle(i: number): string {
    if (this.mode() === 'play')
      return `Pattern ${this.groupName()}-${i + 1} (shift-click to chain)`;
    const on = INSTRUMENTS.filter((inst) => this.pattern().steps[i] & bit(inst));
    return `Step ${i + 1}: ${on.length ? on.join(' ') : 'empty'}`;
  }

  protected groupName = () => (this.group() ? 'II' : 'I');

  protected stepKey(e: MouseEvent, i: number) {
    if (this.preview()) return;
    if (this.mode() === 'play') return this.saveChain(pressLocation(this.chain(), i, e.shiftKey));
    if (this.settingLast()) {
      this.settingLast.set(false);
      return this.save({ ...this.pattern(), length: i + 1 });
    }
    this.save(toggleStep(this.pattern(), i, this.instrument()));
    if (!this.running()) this.audition(this.instrument());
  }

  // ── Buttons ───────────────────────────────────────────

  protected run() {
    if (!this.preview()) this.engine.command(this.gear().id, 'run');
  }

  protected setMode(m: Mode) {
    this.mode.set(m);
    this.settingLast.set(false);
  }

  protected selectInstrument(inst: Instrument) {
    this.instrument.set(inst);
    if (!this.running()) this.audition(inst);
  }

  protected setScale(i: number) {
    this.save({ ...this.pattern(), scale: i });
  }

  protected clear() {
    this.save(emptyPattern());
  }

  protected lastStep() {
    this.settingLast.update((v) => !v);
  }

  /** TAP: while running in WRITE, puts the selected instrument on the step playing; else plays it. */
  protected tap() {
    if (this.preview()) return;
    const step = this.playingStep();
    if (this.mode() === 'write' && this.running() && step >= 0)
      this.save(setStep(this.pattern(), step, this.instrument()));
    else this.audition(this.instrument());
  }

  private audition(inst: Instrument) {
    if (inst === 'AC' || this.preview()) return;
    const id = this.gear().id;
    const note = SOUND_NOTES[inst];
    this.engine.noteOn(note, id);
    this.engine.noteOff(note, id);
  }

  private save(pat: Pattern) {
    if (this.preview()) return;
    this.store.setText(this.gear().id, patternKey(this.editIndex()), encodePattern(pat));
  }

  private saveChain(chain: number[]) {
    this.store.setText(this.gear().id, 'chain', encodeChain(chain));
  }
}
