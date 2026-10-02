import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { GEAR, type GearCategory, type GearKind, INVENTORY, defaultParams } from '../core/gear';
import { CELL } from '../core/patch';
import { GEAR_MIME } from '../floor/patch-floor';
import { GearView } from '../gear/gear-view';
import { HoverInfo } from '../hover-info';
import { PatchStore, SMALL_LAYOUT } from '../patch-store';

type Filter = 'all' | Exclude<GearCategory, 'output'>;

/** Box the gear previews are scaled to fit: normal, and on small screens. */
const TILE = { h: 78, w: 150 };
const TILE_SMALL = { h: 40, w: 96 };

@Component({
  selector: 'kl-inventory',
  imports: [GearView, HoverInfo],
  templateUrl: './inventory.html',
  styleUrl: './inventory.scss',
})
export class Inventory {
  private readonly store = inject(PatchStore);
  protected readonly filters: Filter[] = ['all', 'synth', 'source', 'pedal', 'rack', 'mixer'];
  protected readonly filter = signal<Filter>('all');
  private readonly small = signal(false);
  protected readonly items = computed(() =>
    INVENTORY.filter((k) => this.filter() === 'all' || GEAR[k].category === this.filter()).map(
      (kind) => {
        const def = GEAR[kind];
        const tile = this.small() ? TILE_SMALL : TILE;
        const scale = Math.min(tile.h / (def.h * CELL), tile.w / (def.w * CELL));
        return {
          kind,
          label: def.label,
          scale,
          w: def.w * CELL * scale,
          h: def.h * CELL * scale,
          preview: { id: `shelf-${kind}`, kind, x: 0, y: 0, params: defaultParams(kind) },
        };
      },
    ),
  );

  constructor() {
    const mq = matchMedia(SMALL_LAYOUT);
    this.small.set(mq.matches);
    const update = () => this.small.set(mq.matches);
    mq.addEventListener('change', update);
    inject(DestroyRef).onDestroy(() => mq.removeEventListener('change', update));
  }

  protected dragStart(e: DragEvent, kind: GearKind) {
    e.dataTransfer?.setData(GEAR_MIME, kind);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  }

  /**
   * Clicking (or Enter on) a tile adds the gear in the first free space on the floor, growing
   * the floor if it's full, and scrolls it into view.
   */
  protected add(kind: GearKind) {
    this.store.addFree(kind);
  }
}
