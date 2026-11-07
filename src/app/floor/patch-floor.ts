import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { GEAR, type GearKind, jackDef } from '../core/gear';
import {
  CELL,
  type Gear,
  type JackRef,
  cableHitPath,
  cablePath,
  cableAt,
  drawnExtent,
  gearRect,
  jackPoint,
} from '../core/patch';
import {
  type Box,
  type Size,
  type View,
  anchorView,
  bounds,
  edgeSpeed,
  fitBox,
  floorAt,
  revealBox,
  surfaceSize,
} from '../core/viewport';
import { GearView } from '../gear/gear-view';
import { HoverInfo } from '../hover-info';
import { PatchStore } from '../patch-store';

/** The drag-and-drop payload type for gear coming off the inventory shelf. */
export const GEAR_MIME = 'application/x-klinke-gear';

const isNoteJack = (kind: GearKind, jack: string) => jackDef(kind, jack)?.signal === 'note';

/** Room above a box for its name tag, in floor px. */
const TAG_ROOM = 34;
/** A touch has to move this far (screen px) before it drags gear or stops counting as a tap. */
const SLOP = 10;
/** Two taps this close together (ms) are a double tap. */
const DOUBLE_TAP_MS = 350;
/** Screens that open with the whole rig fitted to the floor, rather than at the desktop zoom. */
const SMALL_SCREEN = '(max-width: 900px), (max-height: 560px), (pointer: coarse)';

interface JackView {
  ref: JackRef;
  dir: 'in' | 'out';
  x: number;
  y: number;
  plugged: boolean;
  pending: boolean;
  /** Carries note events (a NOTE jack), not audio. */
  note: boolean;
  /** A cable is being patched from a jack this one can't take (audio vs NOTE). */
  dim: boolean;
  label: string;
  /** The label plus what the jack is patched to, for screen readers and the tooltip. */
  description: string;
}

/** A plugged cable end picked up off its jack and carried to another one. */
interface Carry {
  pointerId: number;
  cableId: string;
  /** Which end is being carried; the other stays plugged in. */
  end: 'from' | 'to';
  fixed: JackRef;
  sx: number;
  sy: number;
  /** Mouse drags pick the end up at once; a touch waits for SLOP px of travel. */
  lifted: boolean;
}

interface Point {
  x: number;
  y: number;
}

/** A piece of gear being dragged by its body. */
interface GearDrag {
  pointerId: number;
  gear: Gear;
  sx: number;
  sy: number;
  zoom: number;
  /** Scroll offset when the drag started: auto-scrolling carries the box along. */
  left: number;
  top: number;
  /** Latest pointer position (client px). */
  cx: number;
  cy: number;
  /** Touch drags wait for SLOP px of travel, so a tap doesn't nudge the box a cell. */
  moving: boolean;
  /** The pending auto-scroll frame. */
  raf: number;
}

/** A touch that may turn out to be (half of) a double tap. */
interface Tap {
  pointerId: number;
  x: number;
  y: number;
  t: number;
  gearId: string | null;
  cancelled: boolean;
}

@Component({
  selector: 'kl-patch-floor',
  imports: [GearView, HoverInfo],
  templateUrl: './patch-floor.html',
  styleUrl: './patch-floor.scss',
  host: {
    '(pointermove)': 'trackPointer($event)',
    '(dragover)': 'dragOver($event)',
    '(drop)': 'drop($event)',
  },
})
export class PatchFloor {
  protected readonly store = inject(PatchStore);
  protected readonly CELL = CELL;
  protected readonly GEAR = GEAR;

  private readonly scrollRef = viewChild.required<ElementRef<HTMLElement>>('scroll');
  private readonly sizerRef = viewChild.required<ElementRef<HTMLElement>>('sizer');
  private readonly surfaceRef = viewChild.required<ElementRef<HTMLElement>>('surface');

  private readonly smallScreen = matchMedia(SMALL_SCREEN);
  /** Touch screens get touch wording in the hint bar. */
  protected readonly coarse = signal(matchMedia('(pointer: coarse)').matches);
  protected readonly zoomLabel = computed(() => `${Math.round(this.store.zoom() * 100)}%`);

  /** Pointer position in floor px, for drawing the cable being patched. */
  private readonly pointer = signal({ x: 0, y: 0 });

  /** The scroll viewport's size in screen px (kept up to date by a ResizeObserver). */
  private readonly viewportSize = signal<Size>({ w: 0, h: 0 });
  /**
   * The floor's size in floor px. It has no fixed edge: it reaches a screen's worth past the
   * furthest gear (and the lowest cable) to the right and below, so there's always empty floor
   * to drag into, and grows as gear moves out.
   */
  protected readonly size = computed(() => this.floorSize(this.store.zoom()));

  /** The zoom this component last laid out; other zoom changes (± buttons, menu) re-centre. */
  private appliedZoom = this.store.zoom();
  /** True while the view is a fit-all the user hasn't changed, so resizes refit it. */
  private fitted = false;

  /** Touches on the floor itself (gear bodies and empty floor, not controls or jacks). */
  private readonly touches = new Map<number, Point & { kind: string }>();
  private swallowClickUntil = 0;
  private pinch: { anchor: Point; dist: number; zoom: number } | null = null;
  private pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
  private drag: GearDrag | null = null;
  private tap: Tap | null = null;
  private lastTap: Tap | null = null;
  /** The cable end being dragged to another jack (its cable is hidden meanwhile). */
  protected readonly carry = signal<Carry | null>(null);
  /** The click that ends a cable-end drag mustn't also pick the jack up. */
  private swallowJackUntil = 0;

  protected readonly cables = computed(() => {
    const p = this.store.patch();
    const carried = this.carry()?.cableId;
    const byId = new Map(p.gear.map((g) => [g.id, g]));
    // Cables can only be clicked where they're clear of the gear, so the knobs under a cable
    // that crosses a panel still turn.
    const boxes = p.gear.map(gearRect);
    return p.cables
      .filter((c) => c.id !== carried)
      .map((c) => {
        const a = jackPoint(byId.get(c.from.gear)!, c.from.jack);
        const b = jackPoint(byId.get(c.to.gear)!, c.to.jack);
        return {
          id: c.id,
          note: isNoteJack(byId.get(c.from.gear)!.kind, c.from.jack),
          d: cablePath(a, b),
          hit: cableHitPath(a, b, boxes),
        };
      });
  });

  protected readonly jacks = computed<JackView[]>(() => {
    const p = this.store.patch();
    const pending = this.store.pendingJack();
    const pendingKind = pending && p.gear.find((g) => g.id === pending.gear)?.kind;
    const pendingNote = pendingKind ? isNoteJack(pendingKind, pending.jack) : null;
    const byId = new Map(p.gear.map((g) => [g.id, g]));
    const jackName = (ref: JackRef) => {
      const g = byId.get(ref.gear)!;
      const j = jackDef(g.kind, ref.jack)!;
      const note = j.signal === 'note';
      return `${GEAR[g.kind].label} ${j.label ?? (note ? `NOTE ${j.dir.toUpperCase()}` : j.id.toUpperCase())}`;
    };
    return p.gear.flatMap((g) =>
      GEAR[g.kind].jacks.map((j) => {
        const ref = { gear: g.id, jack: j.id };
        const cable = cableAt(p, ref);
        const label = jackName(ref);
        const other =
          cable && (cable.from.gear === g.id && cable.from.jack === j.id ? cable.to : cable.from);
        return {
          ref,
          dir: j.dir,
          ...jackPoint(g, j.id),
          plugged: !!cable,
          pending: pending?.gear === g.id && pending.jack === j.id,
          note: j.signal === 'note',
          dim: pendingNote !== null && pendingNote !== (j.signal === 'note'),
          label,
          description: other
            ? `${label}, patched to ${jackName(other)} (Delete unplugs)`
            : `${label}, empty`,
        };
      }),
    );
  });

  protected readonly pendingPath = computed(() => {
    const ref = this.store.pendingJack();
    const gear = ref && this.store.patch().gear.find((g) => g.id === ref.gear);
    return gear ? cablePath(jackPoint(gear, ref.jack), this.pointer()) : null;
  });
  /** The cable being patched carries notes. */
  protected readonly pendingNote = computed(() => {
    const ref = this.store.pendingJack();
    const gear = ref && this.store.patch().gear.find((g) => g.id === ref.gear);
    return !!gear && isNoteJack(gear.kind, ref.jack);
  });

  constructor() {
    // Zoom changed from outside (± buttons, VIEW menu): keep the middle of the view still.
    effect(() => {
      const z = this.store.zoom();
      untracked(() => {
        if (z === this.appliedZoom) return;
        const el = this.scrollRef().nativeElement;
        const mid = { x: el.clientWidth / 2, y: el.clientHeight / 2 };
        const f = floorAt(this.view(), mid);
        this.setView(anchorView(z, f, mid));
      });
    });

    effect(() => {
      if (this.store.fitRequest()) untracked(() => this.fitAll());
    });
    // Gear added from the shelf: scroll it into view (zooming out only if it can't fit).
    effect(() => {
      const r = this.store.reveal();
      if (r) untracked(() => this.revealGear(r.id));
    });
    effect(() => {
      if (this.store.loaded() && this.smallScreen.matches)
        untracked(() => setTimeout(() => this.fitAll()));
    });

    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (this.smallScreen.matches) this.fitAll();
      // Rotating a phone (or resizing) refits a view that's still the fitted one.
      const ro = new ResizeObserver(() => {
        this.viewportSize.set(this.viewport());
        if (this.fitted && this.smallScreen.matches) this.fitAll();
      });
      const scroll = this.scrollRef().nativeElement;
      this.viewportSize.set(this.viewport());
      ro.observe(scroll);
      const listeners: [string, (e: never) => void][] = [
        ['pointerdown', (e: PointerEvent) => this.touchDown(e)],
        ['pointermove', (e: PointerEvent) => this.touchMove(e)],
        ['pointerup', (e: PointerEvent) => this.touchUp(e)],
        ['pointercancel', (e: PointerEvent) => this.touchUp(e)],
        ['click', (e: MouseEvent) => this.swallowClick(e)],
      ];
      for (const [type, fn] of listeners)
        scroll.addEventListener(type, fn as EventListener, { capture: true });
      const coarse = matchMedia('(pointer: coarse)');
      const onCoarse = () => this.coarse.set(coarse.matches);
      coarse.addEventListener('change', onCoarse);
      destroyRef.onDestroy(() => {
        for (const [type, fn] of listeners)
          scroll.removeEventListener(type, fn as EventListener, { capture: true });
        ro.disconnect();
        coarse.removeEventListener('change', onCoarse);
      });
    });
  }

  // ---- view: zoom and scroll ----

  private view(): View {
    const el = this.scrollRef().nativeElement;
    return { zoom: this.appliedZoom, left: el.scrollLeft, top: el.scrollTop };
  }

  /**
   * Lays out a zoom and scroll position at once. The floor's size is written straight to the DOM
   * (the template binds the same values) so the scroll offset can be set in the same frame.
   */
  private setView(v: View, fitted = false) {
    this.store.setZoom(v.zoom);
    const z = this.store.zoom();
    this.appliedZoom = z;
    this.fitted = fitted;
    const scroll = this.scrollRef().nativeElement;
    scroll.style.setProperty('--cell', `${CELL * z}px`);
    this.surfaceRef().nativeElement.style.scale = String(z);
    this.layoutSize();
    scroll.scrollLeft = v.left;
    scroll.scrollTop = v.top;
  }

  private floorSize(zoom: number): Size {
    return surfaceSize(drawnExtent(this.store.patch()), this.viewportSize(), zoom, CELL);
  }

  /**
   * Writes the floor's size for the current patch and zoom straight to the DOM (the template
   * binds the same values), so it can be scrolled further in the same frame: when zooming, and
   * while auto-scrolling a dragged box out past the edge.
   */
  private layoutSize() {
    this.viewportSize.set(this.viewport());
    const z = this.store.zoom();
    const size = this.floorSize(z);
    const sizer = this.sizerRef().nativeElement.style;
    const surface = this.surfaceRef().nativeElement.style;
    sizer.width = `${size.w * z}px`;
    sizer.height = `${size.h * z}px`;
    surface.width = `${size.w}px`;
    surface.height = `${size.h}px`;
  }

  private viewport() {
    const el = this.scrollRef().nativeElement;
    return { w: el.clientWidth, h: el.clientHeight };
  }

  /** A box on the floor with room for its name tag. */
  private gearBox(g: Gear): Box {
    const def = GEAR[g.kind];
    return { x: g.x * CELL, y: g.y * CELL - TAG_ROOM, w: def.w * CELL, h: def.h * CELL + TAG_ROOM };
  }

  /** Zooms out (never past actual size) so all the gear and its cables fit in the view. */
  protected fitAll() {
    const boxes = this.store.patch().gear.map((g) => this.gearBox(g));
    // Cables sag below the gear; their drawn extent is in floor px already.
    for (const path of this.surfaceRef().nativeElement.querySelectorAll<SVGPathElement>(
      '.cable .wire',
    )) {
      const b = path.getBBox();
      boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height + 8 });
    }
    const box = bounds(boxes);
    if (!box) return;
    this.setView(fitBox(box, this.viewport(), 12, 1), true);
  }

  /** Scrolls a piece of gear into view, zooming out only if it's too big to fit. */
  private revealGear(id: string) {
    const g = this.store.patch().gear.find((x) => x.id === id);
    if (!g) return;
    const vp = this.viewport();
    if (!vp.w || !vp.h) return;
    const fitted = this.fitted;
    this.setView(revealBox(this.view(), this.gearBox(g), vp, 24), fitted);
  }

  /** Zooms in so one piece of gear fills the view. */
  private zoomToGear(id: string) {
    const g = this.store.patch().gear.find((x) => x.id === id);
    if (g) this.setView(fitBox(this.gearBox(g), this.viewport(), 8));
  }

  /** Ctrl + wheel (and trackpad pinch, which browsers send as one) zooms around the pointer. */
  protected wheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
    e.preventDefault();
    const at = this.viewportPoint(e);
    const f = floorAt(this.view(), at);
    // A mouse notch (~100 px) is about ×1.2; a trackpad pinch sends many small deltas.
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const step = Math.max(-0.4, Math.min(0.4, -px * 0.002));
    this.setView(anchorView(this.appliedZoom * Math.exp(step), f, at));
  }

  private viewportPoint(e: { clientX: number; clientY: number }): Point {
    const r = this.scrollRef().nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- touch gestures: pinch, pan, double tap ----
  //
  // Touches are watched in the capture phase, before controls see them, so two fingers pinch
  // anywhere on the floor, even over a synth's knobs once it's zoomed to fill the screen.

  /** What a touch landed on. */
  private touchKind(target: EventTarget | null): 'keys' | 'control' | 'gear' | 'floor' {
    const el = target as Element;
    // Playing surfaces: synth keyboards and the SP-1200's pads.
    if (el.closest('.keys, .sp-pad')) return 'keys';
    if (el.closest('kl-knob, kl-fader, kl-wheel, kl-rocker, button, input, select, [role=slider]'))
      return 'control';
    return el.closest('.placed') ? 'gear' : 'floor';
  }

  private touchDown(e: PointerEvent) {
    if (e.pointerType === 'mouse') return;
    const kind = this.touchKind(e.target);
    if (this.touches.size >= 2) return;
    const first = [...this.touches.values()][0];
    this.touches.set(e.pointerId, { ...this.viewportPoint(e), kind });
    if (!first) {
      // Double taps count on gear bodies and bare floor, not on controls or jacks.
      const placed = (e.target as Element).closest<HTMLElement>('.placed');
      this.tap =
        kind === 'gear' || kind === 'floor'
          ? {
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              t: e.timeStamp,
              gearId: placed?.dataset['gear'] ?? null,
              cancelled: false,
            }
          : null;
      if (kind === 'floor') this.startPan(e.pointerId);
      return;
    }
    // A finger on the keys with another on a control is playing, not zooming.
    const playing =
      (kind === 'keys' && first.kind !== 'floor' && first.kind !== 'gear') ||
      (first.kind === 'keys' && kind !== 'floor' && kind !== 'gear');
    if (playing) {
      this.touches.delete(e.pointerId);
      return;
    }
    this.startPinch();
    // The second finger doesn't press whatever it landed on.
    e.stopPropagation();
  }

  private touchMove(e: PointerEvent) {
    if (!this.touches.has(e.pointerId)) return;
    const p = this.viewportPoint(e);
    const t = this.touches.get(e.pointerId)!;
    t.x = p.x;
    t.y = p.y;
    const tap = this.tap;
    if (tap?.pointerId === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > SLOP)
      tap.cancelled = true;

    if (this.pinch) {
      // Pinching fingers don't turn the knob or play the key they started on.
      e.stopPropagation();
      const [a, b] = [...this.touches.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.setView(anchorView((this.pinch.zoom * dist) / this.pinch.dist, this.pinch.anchor, mid));
    } else if (this.pan?.pointerId === e.pointerId) {
      const el = this.scrollRef().nativeElement;
      el.scrollLeft = this.pan.left - (p.x - this.pan.x);
      el.scrollTop = this.pan.top - (p.y - this.pan.y);
      this.fitted = false;
    }
  }

  private touchUp(e: PointerEvent) {
    if (!this.touches.delete(e.pointerId)) return;
    if (this.pan?.pointerId === e.pointerId) this.pan = null;
    if (this.pinch) {
      // Whatever a pinching finger lifts off shouldn't count as a click.
      this.swallowClickUntil = e.timeStamp + 400;
      if (this.touches.size < 2) {
        this.pinch = null;
        // The finger still down carries on as a pan.
        const [id] = this.touches.keys();
        if (id !== undefined) this.startPan(id);
      }
    }

    const tap = this.tap;
    if (tap?.pointerId !== e.pointerId) return;
    this.tap = null;
    if (tap.cancelled || e.type === 'pointercancel' || e.timeStamp - tap.t > DOUBLE_TAP_MS) {
      this.lastTap = null;
      return;
    }
    const last = this.lastTap;
    if (
      last &&
      tap.t - last.t < DOUBLE_TAP_MS &&
      Math.hypot(tap.x - last.x, tap.y - last.y) < SLOP * 3 &&
      last.gearId === tap.gearId
    ) {
      this.lastTap = null;
      if (tap.gearId) this.zoomToGear(tap.gearId);
      else this.fitAll();
    } else {
      this.lastTap = tap;
    }
  }

  private swallowClick(e: MouseEvent) {
    if (e.timeStamp < this.swallowClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  private startPan(pointerId: number) {
    const p = this.touches.get(pointerId)!;
    const el = this.scrollRef().nativeElement;
    this.pan = { pointerId, x: p.x, y: p.y, left: el.scrollLeft, top: el.scrollTop };
  }

  private startPinch() {
    // A second finger turns a gear drag or a pan into a pinch; put a dragged box back.
    if (this.drag) {
      const g = this.drag.gear;
      this.store.move(g.id, g.x, g.y);
      this.drag = null;
    }
    this.pan = null;
    this.tap = null;
    this.lastTap = null;
    const [a, b] = [...this.touches.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = {
      anchor: floorAt(this.view(), mid),
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.appliedZoom,
    };
  }

  // ---- patching and gear ----

  private floorPoint(e: { clientX: number; clientY: number }, el: Element) {
    const r = el.getBoundingClientRect();
    const z = this.store.zoom();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  }

  protected trackPointer(e: PointerEvent) {
    if (!this.store.pendingJack()) return;
    this.pointer.set(this.floorPoint(e, this.surfaceRef().nativeElement));
  }

  protected surfaceDown(e: PointerEvent) {
    if (e.target !== e.currentTarget) return;
    this.store.selected.set(null);
    this.store.pendingJack.set(null);
  }

  /** Drags a piece of gear by its body, snapping to whole cells. */
  protected gearDown(e: PointerEvent, gear: Gear) {
    if (e.button !== 0) return;
    // No text selection (or native drag of a selection) while a box is carried around.
    if (e.pointerType === 'mouse') e.preventDefault();
    getSelection()?.removeAllRanges();
    this.store.selected.set(gear.id);
    // A second finger on the floor is a pinch, not another drag (touches are counted first).
    if (e.pointerType !== 'mouse' && (this.touches.size > 1 || this.pinch)) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const scroll = this.scrollRef().nativeElement;
    const drag: GearDrag = {
      pointerId: e.pointerId,
      gear,
      sx: e.clientX,
      sy: e.clientY,
      zoom: this.store.zoom(),
      left: scroll.scrollLeft,
      top: scroll.scrollTop,
      cx: e.clientX,
      cy: e.clientY,
      moving: e.pointerType === 'mouse',
      raf: 0,
    };
    this.drag = drag;
    // The box follows the pointer, plus however far the floor has scrolled under it.
    const place = () => {
      const dx = drag.cx - drag.sx + scroll.scrollLeft - drag.left;
      const dy = drag.cy - drag.sy + scroll.scrollTop - drag.top;
      this.store.move(gear.id, gear.x + dx / drag.zoom / CELL, gear.y + dy / drag.zoom / CELL);
    };
    // Holding a box near the edge of the view scrolls the floor that way (growing it as the
    // box goes), so gear can be carried anywhere without letting go.
    const tick = () => {
      drag.raf = 0;
      if (this.drag !== drag || !drag.moving) return;
      const r = scroll.getBoundingClientRect();
      const vx = edgeSpeed(drag.cx, r.left, r.left + scroll.clientWidth);
      const vy = edgeSpeed(drag.cy, r.top, r.top + scroll.clientHeight);
      if (!vx && !vy) return;
      const before = [scroll.scrollLeft, scroll.scrollTop];
      this.layoutSize();
      scroll.scrollLeft += vx;
      scroll.scrollTop += vy;
      if (scroll.scrollLeft === before[0] && scroll.scrollTop === before[1]) {
        // Nothing moved (against the top or left edge): keep watching, in case the pointer does.
        drag.raf = requestAnimationFrame(tick);
        return;
      }
      this.fitted = false;
      place();
      drag.raf = requestAnimationFrame(tick);
    };
    const move = (m: PointerEvent) => {
      if (this.drag !== drag || m.pointerId !== drag.pointerId) return;
      drag.cx = m.clientX;
      drag.cy = m.clientY;
      if (!drag.moving && Math.hypot(drag.cx - drag.sx, drag.cy - drag.sy) < SLOP) return;
      drag.moving = true;
      place();
      if (!drag.raf) drag.raf = requestAnimationFrame(tick);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== drag.pointerId) return;
      cancelAnimationFrame(drag.raf);
      drag.raf = 0;
      if (this.drag === drag) {
        this.drag = null;
        // Let go on top of other gear: slide off it to the nearest free spot.
        if (drag.moving) this.store.settle(gear.id);
      }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected jackClick(e: Event, j: JackView) {
    e.stopPropagation();
    if (e.timeStamp < this.swallowJackUntil) return;
    if (!this.store.pendingJack()) this.pointer.set({ x: j.x, y: j.y });
    this.store.clickJack(j.ref);
  }

  /** On a focused jack, Delete or Backspace pulls its cable out (not the gear it's on). */
  protected jackKey(e: KeyboardEvent, j: JackView) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    e.preventDefault();
    e.stopPropagation();
    if (this.store.unplugAt(j.ref)) this.store.flash(`unplugged ${j.label}`);
  }

  /**
   * Pressing a plugged jack and dragging away picks that cable end up: drop it on another jack
   * to move it there, or anywhere else to pull it out. A press that doesn't move is a click
   * (which starts a new cable from the jack, as before).
   */
  protected jackDown(e: PointerEvent, j: JackView) {
    e.stopPropagation();
    if (e.button !== 0 || !j.plugged || this.store.pendingJack()) return;
    const cable = cableAt(this.store.patch(), j.ref);
    if (!cable) return;
    const end = cable.from.gear === j.ref.gear && cable.from.jack === j.ref.jack ? 'from' : 'to';
    const carry: Carry = {
      pointerId: e.pointerId,
      cableId: cable.id,
      end,
      fixed: end === 'from' ? cable.to : cable.from,
      sx: e.clientX,
      sy: e.clientY,
      lifted: false,
    };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const surface = this.surfaceRef().nativeElement;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== carry.pointerId) return;
      if (!carry.lifted) {
        const slop = m.pointerType === 'mouse' ? 4 : SLOP;
        if (Math.hypot(m.clientX - carry.sx, m.clientY - carry.sy) < slop) return;
        carry.lifted = true;
        this.carry.set(carry);
        // The plugged end stays put: the dashed cable runs from it to the pointer.
        this.store.pendingJack.set(carry.fixed);
      }
      this.pointer.set(this.floorPoint(m, surface));
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== carry.pointerId) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!carry.lifted) return;
      this.swallowJackUntil = u.timeStamp + 400;
      const pending = this.store.pendingJack();
      // Esc while carrying cancels: the cable stays as it was.
      const live = pending?.gear === carry.fixed.gear && pending.jack === carry.fixed.jack;
      this.store.pendingJack.set(null);
      this.carry.set(null);
      if (!live || u.type === 'pointercancel') return;
      const target = document
        .elementFromPoint(u.clientX, u.clientY)
        ?.closest<HTMLElement>('.jack[data-gear]');
      const to = target && { gear: target.dataset['gear']!, jack: target.dataset['jack']! };
      if (to) this.store.moveCableEnd(carry.cableId, carry.end, to);
      else {
        this.store.unplug(carry.cableId);
        this.store.flash('unplugged');
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected dragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes(GEAR_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      // Near the edge of the view, scroll the floor (dragover repeats while the pointer rests).
      const scroll = this.scrollRef().nativeElement;
      const r = scroll.getBoundingClientRect();
      const vx = edgeSpeed(e.clientX, r.left, r.left + scroll.clientWidth, 48, 40);
      const vy = edgeSpeed(e.clientY, r.top, r.top + scroll.clientHeight, 48, 40);
      if (vx || vy) {
        scroll.scrollLeft += vx;
        scroll.scrollTop += vy;
        this.fitted = false;
      }
    }
  }

  protected drop(e: DragEvent) {
    const kind = e.dataTransfer?.getData(GEAR_MIME) as GearKind | undefined;
    if (!kind || !(kind in GEAR)) return;
    e.preventDefault();
    const { x, y } = this.floorPoint(e, this.surfaceRef().nativeElement);
    const def = GEAR[kind];
    const before = this.store.patch();
    this.store.add(kind, x / CELL - def.w / 2, y / CELL - def.h / 2);
    const id = this.store.selected();
    // Dropped on top of other gear: it lands in the nearest free spot instead.
    if (id && this.store.patch() !== before) this.store.settle(id);
  }
}
