import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef } from '../core/gear';
import { SEQ_STEPS } from '../core/jx3p';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Fader, Knob } from './controls';
import { Keyboard } from './keyboard';

/** A PG-200 slide switch: its param and the printed positions, top first. */
interface Switch {
  id: string;
  label: string;
  positions: { name: string; value: number }[];
}

const sw = (id: string, label: string, names: string[], values: number[]): Switch => ({
  id,
  label,
  positions: names.map((name, i) => ({ name, value: values[i] })),
});

interface Status {
  voices: number;
  steps: number;
  at: number;
}

/**
 * The JX-3P with its PG-200 programmer, after the service notes' panel drawings (pp.1–2): the
 * PG-200's DCO-1, DCO-2, VCF, VCA, LFO, ENVELOPE and CHORUS controls across the top (in place of
 * the EDIT MAP, which they edit on the hardware); below them the JX-3P's black face with LFO TRIG,
 * BRILLIANCE, VOLUME and its membrane buttons (CHORUS, MUTE, HOLD, KEY TRANSPOSE and the
 * SEQUENCER's WRITE, TIE, REST, RATE, START / STOP); then the bender and the 61 keys.
 */
@Component({
  selector: 'kl-jx3p-panel',
  imports: [NgTemplateOutlet, Knob, Fader, Keyboard],
  templateUrl: './jx3p-panel.html',
  styleUrl: './jx3p-panel.scss',
})
export class Jx3pPanel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);
  protected readonly SEQ_STEPS = SEQ_STEPS;

  protected readonly status = computed<Status>(() => {
    try {
      return JSON.parse(this.engine.statuses()[this.gear().id] ?? '') as Status;
    } catch {
      return { voices: 0, steps: 0, at: -1 };
    }
  });

  // PG-200 slide switches, as printed (top position first)
  protected readonly lfo1 = sw('dco1Lfo', 'DCO-1 FREQ MOD LFO', ['ON', 'OFF'], [1, 0]);
  protected readonly env1 = sw('dco1Env', 'DCO-1 FREQ MOD ENV', ['ON', 'OFF'], [1, 0]);
  protected readonly lfo2 = sw('dco2Lfo', 'DCO-2 FREQ MOD LFO', ['ON', 'OFF'], [1, 0]);
  protected readonly env2 = sw('dco2Env', 'DCO-2 FREQ MOD ENV', ['ON', 'OFF'], [1, 0]);
  protected readonly envPol = sw('envPolarity', 'DCO ENV POLARITY', ['⋀', '⋁'], [0, 1]);
  protected readonly vcfPol = sw('vcfPolarity', 'VCF ENV POLARITY', ['⋀', '⋁'], [0, 1]);
  protected readonly vcaMode = sw('vcaMode', 'VCA MODE', ['ENV', 'GATE'], [0, 1]);
  protected readonly chorusSw = sw('chorus', 'CHORUS', ['ON', 'OFF'], [1, 0]);
  protected readonly benderSw = sw(
    'benderRange',
    'BENDER RANGE',
    ['WIDE', 'MID', 'NARROW'],
    [1, 0.5, 0],
  );

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params().get(id)!;
  }

  protected on(id: string): boolean {
    return this.value(id) >= 0.5;
  }

  /** Selector knobs' position names for the tooltip. */
  protected optionText(id: string): string {
    const p = this.param(id);
    return p.options && p.steps ? p.options[Math.round(this.value(id) * (p.steps - 1))] : '';
  }

  protected tuneText(): string {
    const semis = Math.round(this.value('dco2Tune') * 24) - 12;
    return `${semis > 0 ? '+' : ''}${semis} semitones`;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  protected isOn(s: Switch, value: number) {
    return Math.abs(this.value(s.id) - value) < 0.01;
  }

  protected toggle(id: string) {
    this.set(id, this.on(id) ? 0 : 1);
  }

  /** WRITE starts a fresh sequence and stops playback; pressing it again ends writing. */
  protected write() {
    if (!this.on('seqWrite')) this.set('seqPlay', 0);
    this.toggle('seqWrite');
  }

  protected startStop() {
    if (!this.on('seqPlay')) this.set('seqWrite', 0);
    this.toggle('seqPlay');
  }

  /** A face button: a command for the unit, WRITE, START / STOP, or a latching function. */
  protected press(action: string) {
    if (this.preview()) return;
    if (action === 'write') this.write();
    else if (action === 'start') this.startStop();
    else if (['lfoTrig', 'tie', 'rest'].includes(action))
      this.engine.command(this.gear().id, action);
    else this.toggle(action);
  }

  // ── Bender ────────────────────────────────────────────

  /** Drag sideways to bend; it springs back to the centre. */
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
