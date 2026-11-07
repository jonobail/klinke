import { Component, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { UndoHistory } from '../history';
import { MidiSync } from '../midi-sync';
import { PatchStore } from '../patch-store';
import { type ProjectInfo, Projects, download } from '../projects';
import { Recorder } from '../recorder';
import { Transport } from '../transport';

interface MenuItem {
  label: string;
  run: () => void;
  /** Greyed out while this says so. */
  disabled?: () => boolean;
  /** Its keyboard shortcut, shown beside it. */
  keys?: string;
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
  protected readonly sync = inject(MidiSync);
  protected readonly projects = inject(Projects);
  protected readonly history = inject(UndoHistory);
  /** The project whose name is being edited in the list. */
  protected readonly renaming = signal<string | null>(null);
  /** The project waiting for a second press of DELETE. */
  protected readonly confirming = signal<string | null>(null);
  protected readonly midiTitle = computed(() => {
    const inputs = this.engine.midiInputs();
    const outputs = this.engine.midiOutputs();
    switch (this.engine.midi()) {
      case 'ready':
        if (!inputs.length && !outputs.length) return 'MIDI ready: plug in a controller';
        return [
          inputs.length ? `MIDI in: ${inputs.join(', ')}` : '',
          outputs.length ? `MIDI out: ${outputs.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
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
        { label: 'Projects…', run: () => this.openMenu.set('PROJECTS') },
        { label: 'New project', run: () => void this.projects.create() },
        { label: 'Save', run: () => this.store.save(), keys: 'Ctrl+S' },
        { label: 'Export project (.klinke)…', run: () => void this.projects.exportBundle() },
        { label: 'Import project (.klinke)…', run: () => this.importBundle() },
        { label: 'Export song (.json)…', run: () => this.projects.exportSong() },
        { label: 'Import song (.json)…', run: () => this.importSong() },
        { label: 'Export patch (.json)…', run: () => this.exportPatch() },
        { label: 'Import patch (.json)…', run: () => this.importPatch() },
        { label: 'Export mix (.wav)', run: () => void this.recorder.exportMix() },
        { label: 'New empty patch', run: () => this.store.reset(false) },
        { label: 'Load demo rig', run: () => this.store.reset(true) },
      ],
    },
    {
      name: 'EDIT',
      items: [
        {
          label: 'Undo',
          run: () => this.history.undo(),
          disabled: () => !this.history.canUndo(),
          keys: 'Ctrl+Z',
        },
        {
          label: 'Redo',
          run: () => this.history.redo(),
          disabled: () => !this.history.canRedo(),
          keys: 'Ctrl+Shift+Z',
        },
        {
          label: 'Delete selected gear',
          run: () => this.store.removeSelected(),
          disabled: () => !this.store.selected(),
          keys: 'Del',
        },
      ],
    },
    {
      name: 'PATCH',
      items: [
        { label: 'Unplug all cables', run: () => this.store.clearCables() },
        { label: 'Cancel cable', run: () => this.store.pendingJack.set(null) },
        { label: 'MIDI clock & sync…', run: () => this.openMenu.set('MIDI') },
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
    if (item.disabled?.()) return;
    this.openMenu.set(null);
    item.run();
  }

  protected closeMenu(e: PointerEvent) {
    if (
      !(e.target as Element).closest?.('.menus, .compact, .midi, .midi-panel, .project, .projects')
    ) {
      this.openMenu.set(null);
      this.renaming.set(null);
      this.confirming.set(null);
    }
  }

  // ── Projects ──────────────────────────────────────────

  protected toggleProjects() {
    this.renaming.set(null);
    this.confirming.set(null);
    this.toggleMenu('PROJECTS');
  }

  private readonly injector = inject(Injector);

  protected startRename(p: ProjectInfo) {
    this.renaming.set(p.id);
    afterNextRender(
      () => document.querySelector<HTMLInputElement>('.projects .name-edit')?.select(),
      { injector: this.injector },
    );
  }

  protected rename(p: ProjectInfo, e: Event) {
    const name = (e.target as HTMLInputElement).value;
    this.renaming.set(null);
    void this.projects.rename(p.id, name);
  }

  protected renameKey(e: KeyboardEvent) {
    e.stopPropagation(); // typing a name mustn't play notes
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    else if (e.key === 'Escape') {
      (e.target as HTMLInputElement).value = '';
      this.renaming.set(null);
    }
  }

  /** DELETE asks once more before it deletes. */
  protected remove(p: ProjectInfo) {
    if (this.confirming() !== p.id) {
      this.confirming.set(p.id);
      return;
    }
    this.confirming.set(null);
    void this.projects.remove(p.id);
  }

  protected when(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected bpmInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) this.transport.setBpm(v);
    el.value = String(this.transport.bpm());
  }

  protected pickPort(kind: 'input' | 'output', e: Event) {
    this.sync.update({ [kind]: (e.target as HTMLSelectElement).value });
  }

  private exportPatch() {
    download(this.store.exportJson(), 'klinke-patch.json', 'application/json');
  }

  private importPatch() {
    this.pickFile(
      'application/json,.json',
      async (f) => void this.store.importJson(await f.text()),
    );
  }

  private importSong() {
    this.pickFile(
      'application/json,.json',
      async (f) => void this.projects.importSong(await f.text()),
    );
  }

  protected importBundle() {
    this.openMenu.set(null);
    this.pickFile('.klinke', (f) => void this.projects.importBundle(f));
  }

  private pickFile(accept: string, use: (file: File) => void) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) use(file);
    };
    input.click();
  }
}
