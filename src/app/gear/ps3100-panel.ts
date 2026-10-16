import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef } from '../core/gear';
import type { Gear } from '../core/patch';
import { NOTE_NAMES, ps3100Settings } from '../core/ps3100';
import { PatchStore } from '../patch-store';
import { Knob } from './controls';
import { Keyboard } from './keyboard';

/**
 * The patch panel's printed jacks (bottom right of the face). Only the audio outputs are real
 * jacks on the floor (FINAL OUT, PHONES, DIRECT OUT, drawn by the floor at the gear's jack
 * positions); the control-voltage jacks are drawn for the look and say so in their tooltip.
 */
const PATCH_ROWS: string[][] = [
  ['FREQ', 'PWM', 'CUTOFF FREQ', 'ATTACK', 'RELEASE', 'PEAK FREQ', '', '', ''],
  ['MG 1', 'S/H OUT', '', 'MG 2 OUT', '', 'GEG OUT', 'GEG OUT', 'OUT', 'OUT'],
  ['VCA', 'S/H IN', 'FREQ', '', 'TRIG OUT', 'TRIG OUT', 'TRIG IN', 'INPUT', 'INPUT'],
  ['JUNCTION', 'JUNCTION', 'JUNCTION', 'JUNCTION', '', '', '', '', ''],
];

/**
 * The PS-3100's front panel, after the photo: TEMPERAMENT ADJUST down the left edge; SIGNAL
 * GENERATORS, DYNAMIC LP FILTERS, ENVELOPE MODIFIERS and RESONATORS (with SAMPLE & HOLD under
 * them); TOTAL SIGNAL MODIFIERS along the top right, above the modulation generators, the general
 * envelope generator, the voltage processors and the patch panel; then the 48 keys in a rosewood
 * case with the pitch lever to their left.
 */
@Component({
  selector: 'kl-ps3100-panel',
  imports: [NgTemplateOutlet, Knob, Keyboard],
  templateUrl: './ps3100-panel.html',
  styleUrl: './ps3100-panel.scss',
})
export class Ps3100Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  /** The jacks down the right edge (the outputs, NOTE IN / OUT), named on the panel beside them. */
  protected readonly edgeJacks = computed(() => this.def().jacks.filter((j) => j.fx > 0.9));
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  private readonly settings = computed(() => ps3100Settings(this.gear().params));
  protected readonly NOTE_NAMES = NOTE_NAMES;
  protected readonly PATCH_ROWS = PATCH_ROWS;
  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);
  /** The MG LEDs blink at their generator's rate. */
  protected readonly mg1Blink = computed(() => `${1 / this.settings().mg1Rate}s`);
  protected readonly mg2Blink = computed(() => `${1 / this.settings().mg2Rate}s`);

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params().get(id)!;
  }

  /** Tooltip text: selector position names, ± for centre-detent knobs, else a percentage. */
  protected valueText(id: string): string | undefined {
    const p = this.param(id);
    const v = this.value(id);
    if (p.options && p.steps) return p.options[Math.round(v * (p.steps - 1))];
    if (p.bipolar) return `${v >= 0.5 ? '+' : ''}${Math.round((v * 2 - 1) * 100)}`;
    return undefined;
  }

  protected temperText(i: number) {
    const cents = Math.round((this.value('temper' + i) * 2 - 1) * 50);
    return `${cents >= 0 ? '+' : ''}${cents} cent`;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  protected on(id: string) {
    return this.value(id) >= 0.5;
  }

  protected toggle(id: string) {
    this.set(id, this.on(id) ? 0 : 1);
  }

  // ── Pitch lever ───────────────────────────────────────

  /** Drag sideways to bend ±2 semitones; it springs back to the centre. */
  protected leverDown(e: PointerEvent) {
    e.stopPropagation();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const id = this.gear().id;
    const pid = e.pointerId;
    const box = el.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      if (m.pointerId !== pid) return;
      const x = ((m.clientX - box.left) / box.width) * 2 - 1;
      this.engine.pitchBend(Math.max(-1, Math.min(1, x)), id);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== pid) return;
      this.engine.pitchBend(0, id);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    move(e);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected leverKey(e: KeyboardEvent) {
    const step = { ArrowLeft: -0.25, ArrowRight: 0.25 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.engine.pitchBend(Math.max(-1, Math.min(1, this.bend() + step)), this.gear().id);
  }
}
