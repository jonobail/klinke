import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef } from '../core/gear';
import { ARP_DIVISIONS, jupiter8Settings } from '../core/jupiter8';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Fader, Knob } from './controls';
import { Keyboard } from './keyboard';

/** A slide switch: its param and the printed positions, top first, with the values they pick. */
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

/** A front-panel button in the strip: its colour (parts list p.1) and what it does. */
interface Button {
  name: string;
  colour: 'red' | 'orange' | 'yellow' | 'white' | 'green' | 'blue' | 'navy';
  /** The param it selects and the value; none for the memory buttons drawn for the look. */
  id?: string;
  value?: number;
}

const group = (
  colour: Button['colour'],
  id: string | undefined,
  names: string[],
  values: number[] = [],
): Button[] => names.map((name, i) => ({ name, colour, id, value: values[i] }));

/**
 * The JUPITER-8's front panel, after the panel drawing in the service notes (pp.26–29): the
 * jack strip along the back; VOLUME and ARPEGGIO RATE, then LFO, VCO MODULATOR, VCO-1, VCO-2,
 * SOURCE MIX, HPF, VCF, VCA, ENV-1 and ENV-2 left to right under their black title bars; the strip
 * of coloured buttons (MASTER TUNE, ARPEGGIO RANGE / MODE, ASSIGN MODE, HOLD, KEY MODE, the patch
 * display and memory); the bender panel and the 61 keys.
 */
@Component({
  selector: 'kl-jupiter8-panel',
  imports: [NgTemplateOutlet, Knob, Fader, Keyboard],
  templateUrl: './jupiter8-panel.html',
  styleUrl: './jupiter8-panel.scss',
})
export class Jupiter8Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  private readonly settings = computed(() => jupiter8Settings(this.gear().params));
  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);
  /** The LFO lamp blinks at its rate. */
  protected readonly lfoBlink = computed(() => `${1 / this.settings().lfoRate}s`);

  // Slide switches, top position first, as printed
  protected readonly arpClock = sw('arpClock', 'ARPEGGIO CLOCK', ['INT', 'EXT'], [0, 1]);
  protected readonly modDest = sw('modDest', 'VCO MOD', ['VCO-1', 'BOTH', 'VCO-2'], [0, 0.5, 1]);
  protected readonly pwmSource = sw('pwmSource', 'PWM', ['LFO', 'MAN', 'ENV-1'], [0, 0.5, 1]);
  protected readonly sync = sw('sync', 'SYNC', ['OFF', 'ON'], [0, 1]);
  protected readonly lowFreq = sw('lowFreq', 'VCO-2 RANGE', ['NORM', 'LOW'], [0, 1]);
  protected readonly slope = sw('slope', 'SLOPE', ['12dB', '24dB'], [0, 1]);
  protected readonly vcfEnvSel = sw('vcfEnvSel', 'VCF ENV', ['ENV-1', 'ENV-2'], [0, 1]);
  protected readonly vcaLfo = sw(
    'vcaLfo',
    'VCA LFO MOD',
    ['3', '2', '1', '0'],
    [1, 2 / 3, 1 / 3, 0],
  );
  protected readonly env1Kf = sw('env1Kf', 'ENV-1 KEY FOLLOW', ['OFF', 'ON'], [0, 1]);
  protected readonly env1Pol = sw('env1Pol', 'ENV-1 POLARITY', ['+', '−'], [0, 1]);
  protected readonly env2Kf = sw('env2Kf', 'ENV-2 KEY FOLLOW', ['OFF', 'ON'], [0, 1]);
  protected readonly porta = sw('porta', 'PORTAMENTO', ['OFF', 'ON'], [0, 1]);
  protected readonly benders = [
    sw('bendVco1', 'BEND VCO-1', ['OFF', 'ON'], [0, 1]),
    sw('bendVco2', 'BEND VCO-2', ['OFF', 'ON'], [0, 1]),
    sw('bendVcfOn', 'BEND VCF', ['OFF', 'ON'], [0, 1]),
  ];

  /** The button strip, left to right, in the parts list's colours (p.1, item 17). */
  protected readonly arpRange = group(
    'orange',
    'arpRange',
    ['1', '2', '3', '4'],
    [0, 1 / 3, 2 / 3, 1],
  );
  protected readonly arpMode = group(
    'yellow',
    'arpMode',
    ['UP', 'DOWN', 'U&D', 'RANDOM'],
    [0.25, 0.5, 0.75, 1],
  );
  protected readonly assign = group(
    'white',
    'assign',
    ['SOLO', 'UNISON', 'POLY 1', 'POLY 2'],
    [0, 1 / 3, 2 / 3, 1],
  );
  protected readonly patchNumber = group('white', undefined, [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
  ]);
  protected readonly patchPreset = [
    ...group('yellow', undefined, ['A', 'B', 'C', 'D']),
    ...group('orange', undefined, ['E', 'F', 'G', 'H']),
  ];
  protected readonly tape = group('blue', undefined, ['SAVE', 'VERIFY', 'LOAD']);

  /** The patch display: the arpeggio's rate when it runs, else the assign mode. */
  protected readonly display = computed(() => {
    const s = this.settings();
    if (s.arp !== 'off') return s.arpExt ? ARP_DIVISIONS[s.arpDivision] : `${s.arpHz.toFixed(0)}HZ`;
    return { solo: 'SOLO', unison: 'UNI', poly1: 'P-1', poly2: 'P-2' }[s.assign];
  });

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
    if (p.bipolar) return `${v >= 0.5 ? '+' : ''}${Math.round((v * 2 - 1) * 50)} cent`;
    return undefined;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  protected isOn(id: string, value: number) {
    return Math.abs(this.value(id) - value) < 0.01;
  }

  /** A strip button: selects its position; the lit ARPEGGIO MODE button turns the arpeggio off. */
  protected press(b: Button) {
    if (!b.id || b.value === undefined) return;
    if (b.id === 'arpMode' && this.isOn(b.id, b.value)) this.set(b.id, 0);
    else this.set(b.id, b.value);
  }

  protected toggle(id: string) {
    this.set(id, this.value(id) >= 0.5 ? 0 : 1);
  }

  // ── Bender ────────────────────────────────────────────

  /**
   * Drag the lever sideways to bend (it springs back); push it up, away from you, for LFO
   * MODULATION, as on the hardware.
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

  /** The LFO MODULATION button: held down, the LFO goes to the VCO / VCF at the LFO MOD depths. */
  protected lfoMod(on: boolean, e: PointerEvent) {
    e.stopPropagation();
    // Hold on to the pointer so letting go anywhere ends it.
    if (on) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!this.preview()) this.engine.command(this.gear().id, on ? 'modOn' : 'modOff');
  }
}
