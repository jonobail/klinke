import { Component, Directive, input, output } from '@angular/core';

/**
 * Shared drag behaviour: drag up/down (or use the wheel / arrow keys) to change a 0–1 value.
 * Pointer events stop here so turning a knob never drags the gear it sits on.
 */
@Directive()
abstract class DragControl {
  protected readonly Math = Math;
  readonly value = input.required<number>();
  readonly label = input('');
  /** A selector with this many positions; wheel and arrow keys move one position at a time. */
  readonly steps = input(0);
  /** What the value means, for the tooltip and screen readers (defaults to a percentage). */
  readonly valueText = input<string>();
  readonly changed = output<number>();
  /** Pixels of travel for the full range. */
  protected travel = 120;
  /** The pointer turning this control, so a second finger on it doesn't start another drag. */
  private dragging: number | null = null;

  protected down(e: PointerEvent) {
    // Stopping the event here keeps the floor from dragging the gear, panning or pinching; on a
    // touch screen a finger on a control turns it (the floor's touch-action is none).
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || this.dragging !== null) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // Don't let focusing scroll the zoomed floor out from under the finger.
    el.focus({ preventScroll: true });
    const id = e.pointerId;
    this.dragging = id;
    const startY = e.clientY;
    const start = this.value();
    const move = (m: PointerEvent) => {
      if (m.pointerId === id) this.emit(start + (startY - m.clientY) / this.travel);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      this.dragging = null;
      this.released();
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected wheel(e: WheelEvent) {
    e.preventDefault();
    this.emit(this.value() - Math.sign(e.deltaY) * this.step());
  }

  /** Called when the drag ends (the pitch wheel springs back). */
  protected released() {}

  private step() {
    return this.steps() > 1 ? 1 / (this.steps() - 1) : 0.05;
  }

  protected key(e: KeyboardEvent) {
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.emit(this.value() + dir * this.step());
  }

  protected emit(v: number) {
    this.changed.emit(Math.min(1, Math.max(0, v)));
  }
}

const HOST = {
  role: 'slider',
  tabindex: '0',
  '[attr.aria-label]': 'label()',
  '[attr.aria-valuenow]': 'Math.round(value() * 100)',
  'aria-valuemin': '0',
  'aria-valuemax': '100',
  '[attr.aria-valuetext]': 'valueText()',
  '[title]': "label() + ' ' + (valueText() ?? Math.round(value() * 100))",
  '(pointerdown)': 'down($event)',
  '(wheel)': 'wheel($event)',
  '(keydown)': 'key($event)',
};

/** A pixel knob: 270° of travel, notch pointing at the value. */
@Component({
  selector: 'kl-knob',
  host: { ...HOST, class: 'kl-knob' },
  template: `<span class="cap" [style.rotate.deg]="value() * 270 - 135"><i></i></span>`,
  styles: `
    :host {
      display: inline-block;
      width: var(--knob, 22px);
      height: var(--knob, 22px);
      cursor: ns-resize;
      touch-action: none;
      outline: none;
    }
    .cap {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: var(--cap-bg, #15161b);
      box-shadow:
        inset -2px -2px 0 #00000099,
        inset 2px 2px 0 #ffffff26,
        0 0 0 1px var(--cap-ring, transparent),
        0 2px 0 #00000080;
    }
    i {
      position: absolute;
      left: calc(50% - 1.5px);
      top: 2px;
      width: 3px;
      height: 35%;
      background: var(--cap-mark, #f1ead6);
    }
    :host(:focus-visible) .cap {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  `,
})
export class Knob extends DragControl {}

/** A vertical fader with a cream cap. */
@Component({
  selector: 'kl-fader',
  host: { ...HOST, class: 'kl-fader', 'aria-orientation': 'vertical' },
  template: `<span class="slot"></span><span class="cap" [style.bottom.%]="value() * 82"></span>`,
  styles: `
    :host {
      position: relative;
      display: inline-block;
      width: 14px;
      height: var(--fader, 60px);
      cursor: ns-resize;
      touch-action: none;
      outline: none;
    }
    .slot {
      position: absolute;
      left: 5px;
      top: 2px;
      bottom: 2px;
      width: 4px;
      background: #0b0c10;
    }
    .cap {
      position: absolute;
      left: 0;
      width: 14px;
      height: 18%;
      background: var(--cap, #ecdcb4);
      box-shadow:
        inset 0 -2px 0 #00000055,
        0 0 0 2px #111;
    }
    :host(:focus-visible) .cap {
      outline: 2px solid var(--accent);
    }
  `,
})
export class Fader extends DragControl {
  protected override travel = 60;
}

/**
 * A performance wheel on the left-hand controller. Drag it up and down; the pitch wheel springs
 * back to its centre detent when let go, the mod wheel stays where it's left.
 */
@Component({
  selector: 'kl-wheel',
  host: { ...HOST, class: 'kl-wheel', 'aria-orientation': 'vertical' },
  template: `<span class="ribs" [style.background-position-y.px]="value() * 60"></span>
    <span class="mark" [style.top.%]="(1 - value()) * 84"></span>`,
  styles: `
    :host {
      position: relative;
      display: inline-block;
      width: 14px;
      height: var(--wheel, 56px);
      overflow: hidden;
      cursor: ns-resize;
      touch-action: none;
      outline: none;
      background: #0b0b0d;
      box-shadow: 0 0 0 2px #2a2a2e;
    }
    .ribs {
      position: absolute;
      inset: 2px;
      background: repeating-linear-gradient(#3a3a3f 0 2px, #1c1c20 2px 5px);
    }
    .mark {
      position: absolute;
      left: 2px;
      right: 2px;
      height: 16%;
      background: #d8d4c8;
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent);
    }
  `,
})
export class Wheel extends DragControl {
  /** Spring back to the middle on release. */
  readonly spring = input(false);
  protected override travel = 60;

  protected override released() {
    if (this.spring()) this.emit(0.5);
  }
}

/** An on / off rocker switch in the colour printed on the panel. */
@Component({
  selector: 'kl-rocker',
  host: {
    role: 'switch',
    tabindex: '0',
    '[class]': "'kl-rocker ' + colour()",
    '[class.on]': 'value() >= 0.5',
    '[attr.aria-checked]': 'value() >= 0.5',
    '[attr.aria-label]': 'label()',
    '[title]': "label() + (value() >= 0.5 ? ' on' : ' off')",
    '(pointerdown)': '$event.stopPropagation()',
    '(click)': 'toggle()',
    '(keydown.enter)': 'toggle()',
    '(keydown.space)': '$event.preventDefault(); $event.stopPropagation(); toggle()',
  },
  template: `<i></i>`,
  styles: `
    :host {
      display: inline-flex;
      flex-direction: column;
      width: 12px;
      height: 18px;
      cursor: pointer;
      outline: none;
      background: #0b0b0d;
      box-shadow: 0 0 0 1px #000;
    }
    i {
      flex: 1;
      margin: 2px 2px 7px;
      background: var(--rocker);
      box-shadow: inset 0 -2px 0 #00000059;
    }
    :host(.on) i {
      margin: 7px 2px 2px;
      box-shadow: inset 0 2px 0 #ffffff59;
    }
    :host(.orange) {
      --rocker: #e07a2e;
    }
    :host(.blue) {
      --rocker: #4d7fc4;
    }
    :host(.white) {
      --rocker: #e8e4d8;
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  `,
})
export class Rocker {
  readonly value = input.required<number>();
  readonly label = input('');
  readonly colour = input<'orange' | 'blue' | 'white'>('white');
  readonly changed = output<number>();

  protected toggle() {
    this.changed.emit(this.value() >= 0.5 ? 0 : 1);
  }
}
