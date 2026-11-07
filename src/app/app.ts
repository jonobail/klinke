import { Component, inject, isDevMode } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { KEY_NOTES } from './core/sound';
import { PatchFloor } from './floor/patch-floor';
import { UndoHistory } from './history';
import { Inventory } from './inventory/inventory';
import { PatchStore } from './patch-store';
import { PianoRoll } from './piano-roll/piano-roll';
import { Projects } from './projects';
import { Recorder } from './recorder';
import { Sequencer } from './sequencer';
import { Timeline } from './timeline/timeline';
import { TopBar } from './top-bar/top-bar';
import { Transport } from './transport';

@Component({
  selector: 'app-root',
  imports: [TopBar, Inventory, PatchFloor, Timeline, PianoRoll],
  template: `
    <kl-top-bar />
    <kl-inventory />
    <kl-patch-floor />
    <kl-timeline />
    @if (transport.openTrack()) {
      <kl-piano-roll />
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-rows: auto auto minmax(240px, 1fr) auto auto;
      grid-template-columns: minmax(0, 1fr);
      height: 100dvh;
    }
    /* Fixed rows, so putting the shelf or timeline away leaves the floor in the stretchy one. */
    kl-top-bar {
      grid-row: 1;
    }
    kl-inventory {
      grid-row: 2;
    }
    kl-patch-floor {
      grid-row: 3;
    }
    kl-timeline {
      grid-row: 4;
    }
    kl-piano-roll {
      grid-row: 5;
      max-height: 40dvh;
    }
    /* Small screens: the floor takes whatever the bars leave (it zooms to fit). */
    @media (max-width: 760px), (max-height: 560px) {
      :host {
        grid-template-rows: auto auto minmax(120px, 1fr) auto auto;
      }
    }
  `,
  host: {
    '(document:keydown)': 'keyDown($event)',
    '(document:keyup)': 'keyUp($event)',
    '(window:blur)': 'engine.allNotesOff()',
  },
})
export class App {
  protected readonly store = inject(PatchStore);
  protected readonly transport = inject(Transport);
  /** Plays and records the MIDI tracks (constructed here so it runs from the start). */
  private readonly sequencer = inject(Sequencer);
  private readonly recorder = inject(Recorder);
  protected readonly engine = inject(AudioEngine);
  private readonly history = inject(UndoHistory);
  /** Keeps the open project saved (constructed here so autosave runs from the start). */
  private readonly projects = inject(Projects);

  constructor() {
    // Browsers only let audio start inside a user gesture, and iOS only counts the end of a
    // touch, a click or a key (not a touch's pointerdown). Listen to all of them at the window,
    // in the capture phase, so no control that stops its events can block the unlock.
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(type, () => this.engine.unlock(), { capture: true, passive: true });
    }
    // Bubble phase: runs after the clicked control's own handler.
    for (const type of ['click', 'keyup']) {
      window.addEventListener(type, () => this.engine.endGesture(), { passive: true });
    }
    // Handy for poking at the app from the dev-tools console.
    if (isDevMode())
      Object.assign(window, {
        klinke: {
          store: this.store,
          transport: this.transport,
          engine: this.engine,
          recorder: this.recorder,
        },
      });
  }

  protected keyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) this.history.redo();
        else this.history.undo();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.store.save();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const step = KEY_NOTES[e.code];
    if (step !== undefined) {
      e.preventDefault();
      if (!e.repeat) this.engine.noteOn(this.engine.base() + step);
    } else if (e.code === 'KeyZ' || e.code === 'KeyX') {
      if (!e.repeat) this.engine.shiftOctave(e.code === 'KeyZ' ? -1 : 1);
    } else if (e.key === ' ') {
      // Space is the transport everywhere (Enter still presses a focused button), and the kill
      // switch: stopping stops every drum machine and sequencer and every note too. With the
      // song stopped but a sequencer running, it just stops them.
      e.preventDefault();
      this.engine.start();
      if (this.transport.playing()) {
        this.transport.stop();
        this.engine.kill();
      } else if (this.engine.busy()) this.engine.kill();
      else this.transport.play();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      this.store.removeSelected();
    } else if (e.key === 'Escape') {
      this.store.pendingJack.set(null);
      this.store.selected.set(null);
    }
  }

  protected keyUp(e: KeyboardEvent) {
    const step = KEY_NOTES[e.code];
    if (step === undefined) return;
    // Changing octave releases everything, so the key's note is always at the current base.
    this.engine.noteOff(this.engine.base() + step);
  }
}
