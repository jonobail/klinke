// PCM-70: one MAIN INPUT, stereo LEFT / RIGHT outputs (service packet fig. 2.2):
//
//   in → INPUT → mono → [program's algorithm] → 15 kHz band limit → wet ─┐
//               └──────────────────────────────────────────── dry ─────┴→ MIX → OUTPUT → out
//
// The program selects one of the engines in pcm-engines.ts (room impulse, tap network or
// resonant chords). The processed path is band-limited to 15 kHz (§2.2: processed signal 20 Hz –
// 15 kHz, from the 33.85 kHz sampling of §4.1.3). A program change mutes the effect briefly while
// the new program loads (§4.1.4).

import { pcm70Settings } from '../../core/devices/pcm70';
import { type Params } from '../unit';
import { ChordEngine, type Engine, EngineSlot, ReverbEngine, TapEngine } from './pcm-engines';
import { RackUnit } from './rack-unit';

export class Pcm70Unit extends RackUnit {
  private readonly mono = this.ctx.createGain();
  private readonly band = this.ctx.createBiquadFilter();
  private readonly slot: EngineSlot<Engine>;

  constructor(ctx: AudioContext) {
    super(ctx);
    // One input: sum whatever arrives to mono.
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.band.type = 'lowpass';
    this.band.frequency.value = 15000;
    this.band.Q.value = -3.0103; // dB: Butterworth, no peak
    this.send.connect(this.mono);
    this.band.connect(this.ret);
    this.slot = new EngineSlot(ctx, this.mono, this.band);
  }

  protected apply(p: Params) {
    const s = pcm70Settings(p);
    const e = this.slot.use(s.program.num, () =>
      s.kind === 'reverb'
        ? new ReverbEngine(this.ctx)
        : s.kind === 'taps'
          ? new TapEngine(this.ctx, s.taps)
          : new ChordEngine(this.ctx),
    );
    if (s.kind === 'reverb') (e as ReverbEngine).set(s.reverb);
    else if (s.kind === 'taps') (e as TapEngine).set(s.taps);
    else (e as ChordEngine).set(s.chords);
  }

  override dispose() {
    this.slot.dispose();
    super.dispose();
  }
}
