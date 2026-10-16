import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef } from '../core/gear';
import type { Gear } from '../core/patch';
import { sh2Settings } from '../core/sh2';
import { PatchStore } from '../patch-store';
import { Fader, Knob } from './controls';
import { Keyboard } from './keyboard';

/** A 2- or 3-position slide switch: its param and the printed position names, top to bottom. */
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
 * The SH-2's front panel, laid out like the hardware (service notes p.1 photos, board layouts
 * pp.5–6): the jack strip along the back; TOTAL TUNE, MODULATOR, VCO, VCO-1, VCO-2, SOURCE MIXER,
 * VCF, VCA and ENV sliders, switches and the four rotary RANGE / WAVEFORM knobs across the grey
 * panel; VOLUME, PORTAMENTO, the bender SENSITIVITY sliders and the bender lever on the black
 * cheek left of the 37 keys.
 */
@Component({
  selector: 'kl-sh2-panel',
  imports: [NgTemplateOutlet, Knob, Fader, Keyboard],
  templateUrl: './sh2-panel.html',
  styleUrl: './sh2-panel.scss',
})
export class Sh2Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  private readonly settings = computed(() =>
    sh2Settings(
      Object.fromEntries(
        this.def().params.map((d) => [d.id, this.gear().params[d.id] ?? d.default]),
      ),
    ),
  );
  /** The MODULATOR's LED blinks at the LFO rate. */
  protected readonly lfoPeriod = computed(() => 1 / this.settings().lfoRate + 's');

  // Switches, as printed on the panel (top position first)
  protected readonly lfoSwitch = sw('lfoWave', 'MODE', ['SINE', 'SQUARE', 'RANDOM'], [0, 0.5, 1]);
  protected readonly pwmSwitch = sw('pwmSource', 'PWM', ['ENV', 'MAN', 'LFO'], [1, 0.5, 0]);
  protected readonly benderSwitch = sw('bendVco1', 'BENDER', ['ON', 'OFF'], [1, 0]);
  protected readonly tuneSwitch = sw('tuneRange', 'TUNE', ['WIDE', 'NARROW'], [0, 1]);
  protected readonly vcfSwitch = sw(
    'vcfEnvSource',
    'VCF ENV',
    ["ENV FOL'R", 'ENV +', 'ENV −'],
    [0, 0.5, 1],
  );
  protected readonly vcaSwitch = sw('vcaMode', 'VCA', ['HOLD', 'ENV', 'GATE'], [0, 0.5, 1]);
  protected readonly gateSwitch = sw(
    'envTrigger',
    'GATE',
    ['GATE+TRIG', 'GATE', 'LFO'],
    [0, 0.5, 1],
  );

  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);

  protected value(id: string): number {
    return this.gear().params[id] ?? this.param(id).default;
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

  // ── Bender lever ──────────────────────────────────────

  /** Drag sideways to bend; it springs back to the centre when let go. */
  protected benderDown(e: PointerEvent) {
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

  protected benderKey(e: KeyboardEvent) {
    const step = { ArrowLeft: -0.25, ArrowRight: 0.25 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.engine.pitchBend(Math.max(-1, Math.min(1, this.bend() + step)), this.gear().id);
  }
}
