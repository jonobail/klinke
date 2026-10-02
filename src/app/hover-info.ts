import { Directive, OnDestroy, computed, input } from '@angular/core';
import { DESCRIPTIONS } from './core/descriptions';
import { GEAR, type GearKind } from './core/gear';

/** How long the pointer must rest on a piece of gear before its description appears. */
const DELAY_MS = 1200;

/**
 * Hover info for gear: rest the mouse on a piece of gear (on the floor or the shelf) and after a
 * moment a card shows its name, what it is and what it's for. Moving away or pressing anything
 * hides it. Screen readers get the same text as the element's description.
 */
@Directive({
  selector: '[klHoverInfo]',
  host: {
    '[attr.aria-description]': 'text()',
    '(pointerenter)': 'enter($event)',
    '(pointermove)': 'move($event)',
    '(pointerleave)': 'hide()',
  },
})
export class HoverInfo implements OnDestroy {
  readonly kind = input.required<GearKind>({ alias: 'klHoverInfo' });
  protected readonly text = computed(() => {
    const d = DESCRIPTIONS[this.kind()];
    return `${GEAR[this.kind()].label}: ${d.what}. ${d.purpose}`;
  });

  private timer?: ReturnType<typeof setTimeout>;
  private card?: HTMLElement;
  private x = 0;
  private y = 0;
  private readonly dismiss = () => this.hide();

  protected enter(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return; // touch: a press means play or drag, not "tell me"
    this.move(e);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(), DELAY_MS);
  }

  protected move(e: PointerEvent) {
    this.x = e.clientX;
    this.y = e.clientY;
    if (this.card) this.place();
  }

  private show() {
    const d = DESCRIPTIONS[this.kind()];
    const card = document.createElement('div');
    card.className = 'kl-hover-info';
    card.setAttribute('role', 'tooltip');
    const name = document.createElement('strong');
    name.textContent = GEAR[this.kind()].label;
    const what = document.createElement('em');
    what.textContent = d.what;
    const purpose = document.createElement('span');
    purpose.textContent = d.purpose;
    card.append(name, what, purpose);
    document.body.append(card);
    this.card = card;
    this.place();
    // Any press (turning a knob, dragging, patching) dismisses it, even if a control stops the event.
    window.addEventListener('pointerdown', this.dismiss, { capture: true });
    window.addEventListener('wheel', this.dismiss, { capture: true, passive: true });
  }

  /** Below-right of the pointer, kept on screen. */
  private place() {
    const card = this.card!;
    const pad = 12;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.min(this.x + 14, window.innerWidth - w - pad);
    const top = this.y + 18 + h > window.innerHeight - pad ? this.y - h - 12 : this.y + 18;
    card.style.left = `${Math.max(pad, left)}px`;
    card.style.top = `${Math.max(pad, top)}px`;
  }

  protected hide() {
    clearTimeout(this.timer);
    this.card?.remove();
    this.card = undefined;
    window.removeEventListener('pointerdown', this.dismiss, { capture: true });
    window.removeEventListener('wheel', this.dismiss, { capture: true });
  }

  ngOnDestroy() {
    this.hide();
  }
}
