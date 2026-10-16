import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef } from '../core/gear';
import { PATCHES, parseTranspose } from '../core/juno60';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Fader, Knob } from './controls';
import { Keyboard } from './keyboard';

/** A lever switch: its param and the printed position names, top to bottom. */
interface Lever {
  id: string;
  label: string;
  positions: { name: string; value: number }[];
}

const lever = (id: string, label: string, names: string[], values: number[]): Lever => ({
  id,
  label,
  positions: names.map((name, i) => ({ name, value: values[i] })),
});

/**
 * The JUNO-60's front panel, laid out like the hardware (service notes p.1): the rear jack strip;
 * ARPEGGIO, LFO, DCO, HPF, VCF, VCA, ENV, CHORUS and MEMORY across the long black panel with
 * their coloured slider caps, lever switches and lit buttons; the bender panel (VOLUME, bender
 * depths, OCTAVE TRANSPOSE, LFO TRIG and the lever) left of the 61 keys, between wooden cheeks.
 */
@Component({
  selector: 'kl-juno60-panel',
  imports: [NgTemplateOutlet, Knob, Fader, Keyboard],
  templateUrl: './juno60-panel.html',
  styleUrl: './juno60-panel.scss',
})
export class Juno60Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));

  protected readonly patches = PATCHES;
  protected readonly arpMode = lever('arpMode', 'MODE', ['UP', 'U&D', 'DOWN'], [0, 0.5, 1]);
  protected readonly arpRange = lever('arpRange', 'RANGE', ['1', '2', '3'], [0, 0.5, 1]);
  protected readonly arpClock = lever('arpClock', 'CLOCK', ['INT', 'EXT'], [0, 1]);
  protected readonly lfoTrig = lever('lfoTrig', 'TRIG', ['AUTO', 'MAN'], [0, 1]);
  protected readonly pwmMode = lever('pwmMode', 'PWM MODE', ['LFO', 'MAN', 'ENV'], [0, 0.5, 1]);
  protected readonly envPolarity = lever('envPolarity', 'POLARITY', ['+', '−'], [0, 1]);
  protected readonly vcaMode = lever('vcaMode', 'VCA', ['ENV', 'GATE'], [0, 1]);
  protected readonly octave = lever('octave', 'OCTAVE', ['UP', 'NORM', 'DOWN'], [1, 0.5, 0]);

  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);
  /** KEY TRANSPOSE: lit while transposed, blinking while it waits for its key. */
  protected readonly transposed = computed(() => parseTranspose(this.gear().text?.['transpose']));
  protected readonly arming = computed(() => this.engine.statuses()[this.gear().id] === 'arm');
  protected readonly patch = computed(() => Number(this.gear().text?.['patch'] ?? 0));

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params().get(id)!;
  }

  protected optionText(id: string): string {
    const p = this.param(id);
    return p.options && p.steps ? p.options[Math.round(this.value(id) * (p.steps - 1))] : '';
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

  protected isAt(l: Lever, value: number) {
    return Math.abs(this.value(l.id) - value) < 0.01;
  }

  // ── Chorus: OFF, I and II (both together for I+II) ────

  private chorusBits() {
    return Math.round(this.value('chorus') * 3);
  }

  protected chorusOn(bit: number) {
    return (this.chorusBits() & bit) !== 0;
  }

  protected chorusPress(bit: number) {
    this.set('chorus', bit ? (this.chorusBits() ^ bit) / 3 : 0);
  }

  // ── Memory: PATCH 1–8 as presets ──────────────────────

  protected load(i: number) {
    if (this.preview()) return;
    const id = this.gear().id;
    for (const [k, v] of Object.entries(PATCHES[i].params)) this.store.setParam(id, k, v);
    this.store.setText(id, 'patch', String(i + 1));
  }

  protected keyTranspose() {
    if (!this.preview()) this.engine.command(this.gear().id, 'keyTranspose');
  }

  /** LFO TRIG: in MAN mode the LFO comes in while it's held. */
  protected lfoTrigDown(e: PointerEvent) {
    e.stopPropagation();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const id = this.gear().id;
    this.engine.command(id, 'lfoOn');
    const up = () => {
      this.engine.command(id, 'lfoOff');
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
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
