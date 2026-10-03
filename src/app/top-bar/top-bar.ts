import { Component, computed, inject, signal } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { PatchStore } from '../patch-store';
import { Recorder } from '../recorder';
import { Transport } from '../transport';

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}

@Component({
  selector: 'kl-top-bar',
  templateUrl: './top-bar.html',
  styleUrl: './top-bar.scss',
  host: { '(document:pointerdown)': 'closeMenu($event)' },
})
export class TopBar {
  protected readonly store = inject(PatchStore);
  protected readonly transport = inject(Transport);
  protected readonly engine = inject(AudioEngine);
  protected readonly recorder = inject(Recorder);
  protected readonly midiTitle = computed(() => {
    const inputs = this.engine.midiInputs();
    switch (this.engine.midi()) {
      case 'ready':
        return inputs.length ? `MIDI in: ${inputs.join(', ')}` : 'MIDI ready: plug in a controller';
      case 'insecure':
        return 'MIDI needs HTTPS or localhost';
      case 'unsupported':
        return "This browser doesn't support Web MIDI";
      case 'denied':
        return 'MIDI access was blocked';
      default:
        return 'MIDI starts with audio';
    }
  });
  protected readonly openMenu = signal<string | null>(null);

  protected readonly menus: { name: string; items: MenuItem[] }[] = [
    {
      name: 'FILE',
      items: [
        { label: 'New empty patch', run: () => this.store.reset(false) },
        { label: 'Load demo rig', run: () => this.store.reset(true) },
        { label: 'Save', run: () => this.store.save() },
        { label: 'Export patch (.json)…', run: () => this.exportPatch() },
        { label: 'Export mix (.wav)', run: () => void this.recorder.exportMix() },
        { label: 'Import patch (.json)…', run: () => this.importPatch() },
      ],
    },
    {
      name: 'EDIT',
      items: [{ label: 'Delete selected gear', run: () => this.store.removeSelected() }],
    },
    {
      name: 'PATCH',
      items: [
        { label: 'Unplug all cables', run: () => this.store.clearCables() },
        { label: 'Cancel cable', run: () => this.store.pendingJack.set(null) },
      ],
    },
    {
      name: 'VIEW',
      items: [
        { label: 'Zoom in', run: () => this.store.zoomBy(1) },
        { label: 'Zoom out', run: () => this.store.zoomBy(-1) },
        { label: 'Actual size (100%)', run: () => this.store.setZoom(1) },
        { label: 'Fit all gear', run: () => this.store.fitAll() },
      ],
    },
  ];

  protected toggleMenu(name: string) {
    this.openMenu.update((m) => (m === name ? null : name));
  }

  protected pick(item: MenuItem) {
    this.openMenu.set(null);
    item.run();
  }

  protected closeMenu(e: PointerEvent) {
    if (!(e.target as Element).closest?.('.menus, .compact')) this.openMenu.set(null);
  }

  protected bpmInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) this.transport.setBpm(v);
    el.value = String(this.transport.bpm());
  }

  private exportPatch() {
    const blob = new Blob([this.store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'klinke-patch.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private importPatch() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) this.store.importJson(await file.text());
    };
    input.click();
  }
}
