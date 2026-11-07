import { Injectable, effect, signal } from '@angular/core';
import { type RecOptions, parseRecOptions, recLatency } from './core/metronome';

const REC_KEY = 'klinke.rec.v1';

/**
 * Recording options kept in this browser: the metronome, the count-in and latency compensation
 * (see `core/metronome.ts`). Settings of the room, not of the song, so they aren't in projects.
 */
@Injectable({ providedIn: 'root' })
export class RecSettings {
  readonly options = signal<RecOptions>(load());

  constructor() {
    effect(() => {
      const o = this.options();
      try {
        localStorage.setItem(REC_KEY, JSON.stringify(o));
      } catch {
        // Private mode or full storage: the settings just won't outlast the page.
      }
    });
  }

  /**
   * Seconds to move recorded material earlier: the time from the audio clock to your ears as the
   * browser reports it (output + base latency), when auto is on, plus the manual offset.
   */
  latency(ctx: AudioContext | undefined): number {
    const out = ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0;
    return recLatency(this.options(), out);
  }

  update(change: Partial<RecOptions>) {
    this.options.update((o) => parseRecOptions({ ...o, ...change }));
  }
}

function load(): RecOptions {
  try {
    return parseRecOptions(JSON.parse(localStorage.getItem(REC_KEY) ?? 'null'));
  } catch {
    return parseRecOptions(null);
  }
}
