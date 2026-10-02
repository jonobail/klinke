// PCM-80, after the service manual's block diagram (p. 1-1):
//
//   L / R in → INPUT ─┬→ EFFECTS (the algorithm's engine) → ret → wet ─┐
//                     └──────────────────────────────────────── dry ───┴→ MIX → OUTPUT → L / R out
//
// Stereo all the way through. The algorithm selects one of the engines in pcm-engines.ts; the
// tempo echoes, delays and step-based taps follow TEMPO × NOTE. Changing algorithm mutes the effect
// for a moment while the new one loads, as a program load does on the hardware.

import { pcm80Settings } from '../../core/devices/pcm80';
import { type Params } from '../unit';
import {
  ChordEngine,
  ChorusVerbEngine,
  type Engine,
  EngineSlot,
  ReverbEngine,
  TapEngine,
} from './pcm-engines';
import { RackUnit } from './rack-unit';

export class Pcm80Unit extends RackUnit {
  private readonly slot = new EngineSlot<Engine>(this.ctx, this.send, this.ret);

  protected apply(p: Params) {
    const s = pcm80Settings(p);
    const ctx = this.ctx;
    const e = this.slot.use(String(s.algo), () => {
      switch (s.kind) {
        case 'reverb':
          return new ReverbEngine(ctx, s.algo === 0);
        case 'chorusVerb':
          return new ChorusVerbEngine(ctx, s.taps);
        case 'taps':
          return new TapEngine(ctx, s.taps);
        case 'chords':
          return new ChordEngine(ctx);
      }
    });
    switch (s.kind) {
      case 'reverb':
        return (e as ReverbEngine).set(s.reverb);
      case 'chorusVerb':
        return (e as ChorusVerbEngine).set(s.taps, s.reverb, s.verb);
      case 'taps':
        return (e as TapEngine).set(s.taps);
      case 'chords':
        return (e as ChordEngine).set(s.chords);
    }
  }

  override dispose() {
    this.slot.dispose();
    super.dispose();
  }
}
