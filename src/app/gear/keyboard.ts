import { Component, computed, inject, input } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import type { KeyboardDef } from '../core/gear';
import { PatchStore } from '../patch-store';

/** Pitch classes of the black keys. */
const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (step: number) => BLACK.has(((step % 12) + 12) % 12);

/**
 * A synth's on-screen keyboard. Play by clicking or sliding across the keys; each finger plays
 * its own key, so chords work on touch screens. Held notes (from any source) light up. Keys are
 * semitone steps from the engine's base C, so Z / X octave shifts move them too.
 */
@Component({
  selector: 'kl-keyboard',
  host: {
    class: 'keys',
    '[style.--white-w.%]': '100 / whiteKeys().length',
    '(pointerdown)': 'down($event)',
  },
  template: `
    @for (k of whiteKeys(); track k) {
      <span class="white" [attr.data-step]="k" [class.down]="held().has(k)"></span>
    }
    @for (b of blackKeys(); track b.step) {
      <span
        class="black"
        [attr.data-step]="b.step"
        [class.down]="held().has(b.step)"
        [style.left.%]="b.left"
      ></span>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      gap: 2px;
      padding: 2px;
      cursor: pointer;
      touch-action: none;
      background: #0d0e12;
    }
    .white {
      flex: 1;
      background: #fbf9f1;
      box-shadow: inset 0 -4px 0 #d7d1c0;
      &.down {
        background: #f2c9a0;
        box-shadow: inset 0 -1px 0 #d7a77a;
      }
    }
    .black {
      position: absolute;
      top: 2px;
      // 60 % of a white key wide, centred on the line between two whites.
      width: calc(var(--white-w) * 0.6);
      height: 58%;
      margin-left: calc(var(--white-w) * -0.3);
      background: #15161b;
      &.down {
        background: #e8505b;
      }
    }
  `,
})
export class Keyboard {
  readonly gearId = input.required<string>();
  readonly layout = input.required<KeyboardDef>();
  readonly preview = input(false);

  private readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);

  private readonly steps = computed(() => {
    const { from, keys } = this.layout();
    return Array.from({ length: keys }, (_, i) => from + i);
  });
  protected readonly whiteKeys = computed(() => this.steps().filter((s) => !isBlack(s)));
  protected readonly blackKeys = computed(() => {
    const whites = this.whiteKeys();
    return this.steps()
      .filter(isBlack)
      .map((step) => ({
        step,
        left: (whites.filter((w) => w < step).length / whites.length) * 100,
      }));
  });
  /** Held notes on this synth, as steps above the base C. */
  protected readonly held = computed(() => {
    const base = this.engine.base();
    return new Set((this.engine.held()[this.gearId()] ?? []).map((n) => n - base));
  });

  protected down(e: PointerEvent) {
    e.stopPropagation();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const id = this.gearId();
    this.store.selected.set(id); // the computer keyboard now plays this synth too
    // Each finger runs its own handlers, so two fingers play two keys independently.
    const pid = e.pointerId;
    let note: number | null = null;
    const play = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const key = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>('[data-step]');
      const next =
        key && el.contains(key) ? this.engine.base() + Number(key.dataset['step']) : null;
      if (next === note) return;
      if (note !== null) this.engine.noteOff(note, id);
      note = next;
      if (note !== null) this.engine.noteOn(note, id);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (note !== null) this.engine.noteOff(note, id);
      el.removeEventListener('pointermove', play);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    play(e);
    el.addEventListener('pointermove', play);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
