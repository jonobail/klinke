import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef } from '../core/gear';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Fader, Knob } from './controls';
import { Keyboard } from './keyboard';

/** A 3- or 4-position slide switch: its param and the printed position names, top to bottom. */
interface Switch {
  id: string;
  label: string;
  /** Printed positions, top first, each with the param value it selects. */
  positions: { name: string; value: number }[];
}

const sw = (id: string, label: string, names: string[], values: number[]): Switch => ({
  id,
  label,
  positions: names.map((name, i) => ({ name, value: values[i] })),
});

/**
 * The SH-101's front panel, laid out like the hardware: the jack strip along the back; TUNE,
 * MODULATOR, VCO, SOURCE MIXER, VCF, VCA and ENV across the top; the sequencer / arpeggio buttons
 * with their LEDs and the logo in the middle; VOLUME, PORTAMENTO, TRANSPOSE and the bender to the
 * left of the 32 keys.
 */
@Component({
  selector: 'kl-sh101-panel',
  imports: [NgTemplateOutlet, Knob, Fader, Keyboard],
  templateUrl: './sh101-panel.html',
  styleUrl: './sh101-panel.scss',
})
export class Sh101Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));

  // Switches, as printed on the panel (top position first)
  protected readonly pwmSwitch = sw('pwmSource', 'PWM', ['LFO', 'MAN', 'ENV'], [0, 0.5, 1]);
  protected readonly subSwitch = sw(
    'subMode',
    'SUB OSC',
    ['1 OCT', '2 OCT', '2 OCT PW'],
    [0, 0.5, 1],
  );
  protected readonly vcaSwitch = sw('vcaMode', 'VCA', ['ENV', 'GATE'], [0, 1]);
  protected readonly trigSwitch = sw(
    'envTrigger',
    'TRIG',
    ['GATE+TRIG', 'GATE', 'LFO'],
    [0, 0.5, 1],
  );
  protected readonly portaSwitch = sw('portaMode', 'PORTA', ['ON', 'OFF', 'AUTO'], [0.5, 0, 1]);
  protected readonly transposeSwitch = sw('transpose', 'TRANSPOSE', ['H', 'M', 'L'], [1, 0.5, 0]);

  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params().get(id)!;
  }

  /** Selector knobs' position names for the tooltip. */
  protected optionText(id: string): string {
    const p = this.param(id);
    return p.options && p.steps ? p.options[Math.round(this.value(id) * (p.steps - 1))] : '';
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  protected isOn(s: Switch, value: number) {
    return Math.abs(this.value(s.id) - value) < 0.01;
  }

  // ── Function buttons ──────────────────────────────────

  protected seqIs(mode: 'load' | 'play') {
    return this.value('seq') === (mode === 'load' ? 0.5 : 1);
  }

  /** LOAD / PLAY toggle the sequencer mode (pressing the lit one turns it off). */
  protected seqPress(mode: 'load' | 'play') {
    this.set('seq', this.seqIs(mode) ? 0 : mode === 'load' ? 0.5 : 1);
  }

  /** The arpeggio buttons: UP 1/3, U&D 2/3, DOWN 1 (pressing the lit one turns it off). */
  protected arpIs(v: number) {
    return Math.abs(this.value('arp') - v) < 0.01;
  }

  protected arpPress(v: number) {
    this.set('arp', this.arpIs(v) ? 0 : v);
  }

  /** KEY TRANSPOSE: while loading a sequence it enters a rest (service notes §9). */
  protected keyTranspose() {
    if (!this.preview()) this.engine.command(this.gear().id, 'rest');
  }

  // ── Bender lever ──────────────────────────────────────

  /**
   * Drag sideways to bend (it springs back to the centre); push it up, away from you, to add the
   * LFO to the pitch at the LFO MOD depth, like the hardware's lever.
   */
  protected benderDown(e: PointerEvent) {
    e.stopPropagation();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const id = this.gear().id;
    const pid = e.pointerId;
    const box = el.getBoundingClientRect();
    const y0 = e.clientY;
    let pushed = false;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== pid) return;
      const x = ((m.clientX - box.left) / box.width) * 2 - 1;
      this.engine.pitchBend(Math.max(-1, Math.min(1, x)), id);
      const push = y0 - m.clientY > 8;
      if (push !== pushed) {
        pushed = push;
        this.engine.command(id, push ? 'modOn' : 'modOff');
      }
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== pid) return;
      this.engine.pitchBend(0, id);
      if (pushed) this.engine.command(id, 'modOff');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    move(e);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected benderKey(e: KeyboardEvent) {
    const step = { ArrowLeft: -0.25, ArrowRight: 0.25 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.engine.pitchBend(Math.max(-1, Math.min(1, this.bend() + step)), this.gear().id);
  }
}
