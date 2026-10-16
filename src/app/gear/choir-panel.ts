import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import {
  MAX_SINGERS,
  VOWELS,
  choirSettings,
  nearestVowel,
  parseChoirStatus,
  tractDiameters,
  vowelAt,
} from '../core/choir';
import { GEAR, type ParamDef } from '../core/gear';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Knob } from './controls';
import { Keyboard } from './keyboard';

/** Sections in the tract display. */
const TRACT_BARS = 24;
/** The face is drawn on a pixel grid this many pixels square. */
const FACE = 20;

/**
 * The CHOIR-16 front panel: VOICES (mode, singers, style, legato and a lamp per singer), SINGER
 * (the body, with a pixel face that mouths the vowel being sung), the VOWEL chart to click or
 * drag across with its motion controls, VOICE (breath, rasp, vibrato, envelope) and STAGE (room,
 * width, volume, and a side view of the tract's shape). Keys along the bottom.
 */
@Component({
  selector: 'kl-choir-panel',
  imports: [NgTemplateOutlet, Knob, Keyboard],
  templateUrl: './choir-panel.html',
  styleUrl: './choir-panel.scss',
})
export class ChoirPanel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  protected readonly keyboard = computed(() => this.def().keyboard!);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly settings = computed(() => choirSettings(this.gear().params));
  private readonly live = computed(() => parseChoirStatus(this.engine.statuses()[this.gear().id]));
  protected readonly VOWELS = VOWELS;
  protected readonly Math = Math;
  protected readonly seats = Array.from({ length: MAX_SINGERS }, (_, i) => i);

  /** Lamp per seat: 'on' singing, 'seat' on stage but quiet, '' not on stage. */
  protected lamp(i: number): string {
    if (((this.live()?.mask ?? 0) >> i) & 1) return 'on';
    return i < this.settings().singers ? 'seat' : '';
  }

  /** The vowel shown: what the newest singer is singing, else the chart setting. */
  protected readonly vowel = computed(() => {
    const l = this.live();
    if (l && l.mask) return { x: l.x, y: l.y, level: l.level };
    return { x: this.value('vowelX'), y: this.value('vowelY'), level: 0 };
  });
  protected readonly vowelName = computed(
    () => nearestVowel(this.vowel().x, this.vowel().y).symbol,
  );
  private readonly art = computed(() => vowelAt(this.vowel().x, this.vowel().y));

  /** The tract seen from the side: one bar per section, glottis left, lips right. */
  protected readonly tract = computed(() => {
    const d = tractDiameters(TRACT_BARS, this.art());
    return Array.from(d, (v, i) => ({ x: i * 4, h: Math.min(28, v * 8) }));
  });

  /** The face's mouth, in pixels: spread by the lips, opened by the jaw and by singing. */
  protected readonly mouth = computed(() => {
    const a = this.art();
    const singing = this.vowel().level;
    const w = Math.round(2 + a.lips * 2.6);
    const open = Math.max(
      1,
      Math.round((0.5 + a.jaw * 4) * (0.35 + 0.65 * Math.min(1, singing * 1.4))),
    );
    const x = Math.round((FACE - w) / 2);
    const y = 13;
    // The tongue shows in an open mouth, higher for close vowels, further in for back ones.
    const tongue = open >= 3 ? Math.max(1, Math.round(open * a.height * 0.4)) : 0;
    return { x, y, w, h: open, tongue, teeth: open >= 2 };
  });

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params().get(id)!;
  }

  protected valueText(id: string): string | undefined {
    const p = this.param(id);
    const v = this.value(id);
    if (p.options && p.steps) return p.options[Math.round(v * (p.steps - 1))];
    if (p.bipolar) return `${v >= 0.5 ? '+' : ''}${Math.round((v * 2 - 1) * 100)}`;
    return undefined;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  // ── Vowel chart ───────────────────────────────────────

  /** Click or drag on the chart to move the vowel (front left, close at the top). */
  protected chartDown(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    const pid = e.pointerId;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== pid) return;
      const box = el.getBoundingClientRect();
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      this.set('vowelX', clamp((m.clientX - box.left) / box.width));
      this.set('vowelY', clamp((m.clientY - box.top) / box.height));
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== pid) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    move(e);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected chartKey(e: KeyboardEvent) {
    const step: Record<string, [string, number]> = {
      ArrowLeft: ['vowelX', -0.05],
      ArrowRight: ['vowelX', 0.05],
      ArrowUp: ['vowelY', -0.05],
      ArrowDown: ['vowelY', 0.05],
    };
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    this.set(s[0], Math.min(1, Math.max(0, this.value(s[0]) + s[1])));
  }
}
