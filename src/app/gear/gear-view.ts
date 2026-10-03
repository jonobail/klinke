import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { GEAR, type ParamDef } from '../core/gear';
import { CELL, type Gear } from '../core/patch';
import { AudioEngine } from '../audio/audio-engine';
import { PatchStore } from '../patch-store';
import { Transport } from '../transport';
import { Fader, Knob, Rocker, Wheel } from './controls';
import { Keyboard } from './keyboard';
import { Sh101Panel } from './sh101-panel';
import { Sp1200Panel } from './sp1200-panel';

/** Draws one piece of gear at 1:1 floor scale. In preview mode (the inventory) it's inert. */
@Component({
  selector: 'kl-gear-view',
  imports: [NgTemplateOutlet, Knob, Fader, Rocker, Wheel, Sp1200Panel, Keyboard, Sh101Panel],
  host: {
    '[class]': "'gear ' + gear().kind + ' ' + def().category",
    '[style.--face]': 'def().face?.panel',
    '[style.--legend]': 'def().face?.text',
    '[style.--lcd]': 'def().face?.display',
    '[class.preview]': 'preview()',
    // Shelf previews are pictures: keep their knobs out of the tab order and the a11y tree.
    '[attr.inert]': "preview() ? '' : null",
    '[style.width.px]': 'def().w * CELL',
    '[style.height.px]': 'def().h * CELL',
  },
  templateUrl: './gear-view.html',
  styleUrl: './gear-view.scss',
})
export class GearView {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly CELL = CELL;
  protected readonly store = inject(PatchStore);
  protected readonly transport = inject(Transport);
  protected readonly engine = inject(AudioEngine);
  protected readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly knobs = computed(() => this.def().params.filter((p) => p.id !== 'bypass'));
  protected readonly param = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  /** A synth's front panel: sections left to right, each a grid of controls. */
  protected readonly sections = computed(() => {
    const byId = this.param();
    return (this.def().sections ?? []).map((s) => {
      const rows = (s.rows ?? (s.params ?? []).map((id) => [id])).map((r) =>
        r.map((id) => (id ? byId.get(id)! : null)),
      );
      const cols = Math.max(...rows.map((r) => r.length));
      // Pad short rows so every row starts in the first column of the grid.
      const padded = rows.map((r) => [...r, ...Array<null>(cols - r.length).fill(null)]);
      return { ...s, rows: padded, cols };
    });
  });
  /** What a rack unit's display shows. */
  protected readonly displayText = computed(() => this.def().display?.(this.gear().params) ?? '');
  /** The synth the computer keyboard plays (marked on its panel). */
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  protected readonly bend = computed(() => this.engine.bends()[this.gear().id] ?? 0);
  protected readonly bendText = computed(() => {
    const n = Math.round(this.bend() * 100);
    return n > 0 ? `+${n}` : String(n);
  });
  protected readonly meterLevels = computed(() => this.engine.levels()[this.gear().id] ?? []);
  protected readonly strips = [1, 2, 3, 4, 5];
  /** MF-104 knobs, top row then bottom row as on the panel. */
  protected readonly mfKnobs = ['drive', 'time', 'feedback', 'mix', 'output', 'loopGain'];
  protected readonly meterSegs = [0, 1, 2, 3, 4, 5, 6, 7];
  protected readonly bypassed = computed(() => this.gear().params['bypass'] >= 0.5);

  protected value(p: ParamDef | string): number {
    return this.gear().params[typeof p === 'string' ? p : p.id] ?? 0;
  }

  /** Tooltip text: a selector's position name, or a centre-detented knob as ±. */
  protected valueText(p: ParamDef): string | undefined {
    const v = this.value(p);
    if (p.options && p.steps) return p.options[Math.round(v * (p.steps - 1))];
    if (p.bipolar) {
      const n = Math.round((v * 2 - 1) * 100);
      return n > 0 ? `+${n}` : String(n);
    }
    return undefined;
  }

  protected set(param: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, param, v);
  }

  /** A bicolour level LED (the MF-104's DRIVE and LOOP): off, green with signal, red when hot. */
  protected led(channel: number): 'off' | 'green' | 'red' {
    const v = this.meterLevels()[channel] ?? 0;
    return v > 0.93 ? 'red' : v > 0.45 ? 'green' : 'off';
  }

  /** Meter segments lit for a reading: segment index → lit? */
  protected lit(channel: number, seg: number) {
    return (this.meterLevels()[channel] ?? 0) * this.meterSegs.length > seg + 0.5;
  }

  /** The pitch wheel: 0–1 from the control, -1…+1 to the engine. */
  protected bendWheel(v: number) {
    if (!this.preview()) this.engine.pitchBend(v * 2 - 1, this.gear().id);
  }

  protected stomp(e: Event) {
    e.stopPropagation();
    this.set('bypass', this.bypassed() ? 0 : 1);
  }
}
