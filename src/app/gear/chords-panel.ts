import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import {
  CHORDS_GEAR,
  DEFAULT_PROGRESSION,
  NOTE_NAMES,
  SCALES,
  STYLES,
  chordName,
  chordsSettings,
  diatonicChord,
  formatProgression,
  parseProgression,
  parseStatus,
  roman,
} from '../core/chords';
import type { ParamDef } from '../core/gear-types';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Knob } from './controls';

/**
 * The CHORD-8 front panel: the LCD with the chord sounding, the generator (STYLE, DICE, REC),
 * eight pads holding the progression (hold one to play it; the wheel over a pad changes its
 * chord), the HARMONY selectors and the PLAYER FX along the bottom.
 */
@Component({
  selector: 'kl-chords-panel',
  imports: [NgTemplateOutlet, Knob],
  templateUrl: './chords-panel.html',
  styleUrl: './chords-panel.scss',
})
export class ChordsPanel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly params = new Map(CHORDS_GEAR.params.map((d) => [d.id, d]));
  private readonly settings = computed(() => chordsSettings(this.gear().params));
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  protected readonly status = computed(() => parseStatus(this.engine.statuses()[this.gear().id]));
  private readonly progression = computed(
    () => parseProgression(this.gear().text?.['prog']) ?? DEFAULT_PROGRESSION,
  );
  /** Each pad's numeral and chord name in the current key, scale and size. */
  protected readonly pads = computed(() => {
    const s = this.settings();
    const lit = new Set(this.status().lit);
    return this.progression().map((d, i) => ({
      roman: roman(s.scale, d.degree),
      name: chordName(diatonicChord(s.key, s.scale, d.degree, s.size || d.size)),
      lit: lit.has(i),
      next: this.status().rec === i,
    }));
  });
  protected readonly keyLine = computed(() => {
    const s = this.settings();
    const scale = SCALES.find((x) => x.steps === s.scale)!.label;
    return `${NOTE_NAMES[s.key]} ${scale} · ${STYLES[s.style]}`;
  });

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params.get(id)!;
  }

  /** Tooltip text: selector names, BEND in semitones, times in ms, else a percentage. */
  protected valueText(id: string): string | undefined {
    const p = this.param(id);
    const v = this.value(id);
    const s = this.settings();
    if (p.options && p.steps) return p.options[Math.round(v * (p.steps - 1))];
    if (id === 'bend') return s.bend ? `${s.bend > 0 ? '+' : ''}${s.bend} semitones` : 'off';
    if (id === 'bendTime') return `${Math.round(s.bendTime)} ms`;
    if (id === 'bounceTime') return `${Math.round(s.bounceGap)} ms`;
    if (id === 'bounce') return s.bounce ? `${s.bounce} repeats` : 'off';
    if (id === 'strum') return `${Math.round(s.strum)} ms`;
    return undefined;
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

  protected command(name: string) {
    if (!this.preview()) this.engine.command(this.gear().id, name);
  }

  // ── Pads ──────────────────────────────────────────────

  /** Hold a pad to play its chord; each finger holds its own pad. */
  protected padDown(e: PointerEvent, i: number) {
    e.stopPropagation();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const id = this.gear().id;
    this.store.selected.set(id); // the computer keyboard now plays it too
    this.engine.command(id, `pad:${i}:on`);
    const pid = e.pointerId;
    const up = (u: PointerEvent) => {
      if (u.pointerId !== pid) return;
      this.engine.command(id, `pad:${i}:off`);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** The wheel over a pad steps its chord through the scale's degrees. */
  protected padWheel(e: WheelEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    if (this.preview()) return;
    const by = e.deltaY < 0 ? 1 : -1;
    const pads = this.progression().map((d, j) =>
      j === i ? { ...d, degree: (d.degree + by + 7) % 7 } : d,
    );
    this.store.setText(this.gear().id, 'prog', formatProgression(pads));
  }
}
