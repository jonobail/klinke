// MODEL 200 digital reverb (see core/devices/model200.ts for the sources and the maths).
//
//   send → [impulse: pre-echoes + tail, ROLLOFF] → random-modulation delay → 10 kHz anti-alias
//        → ret
//
// The impulse is rebuilt (debounced) when a setting that shapes it changes. The slow pitch
// modulation stands in for the processor's random modulation (the Addendum's variation 0 is "more
// metallic" and avoids "modulation noise", so the modulation is off there).

import {
  MODEL200_BANDWIDTH,
  model200Impulse,
  model200Key,
  model200Settings,
} from '../../core/devices/model200';
import { type Params, glide } from '../unit';
import { ImpulseConvolver } from './impulse-convolver';
import { RackUnit } from './rack-unit';

export class Model200Unit extends RackUnit {
  private readonly ir = new ImpulseConvolver(this.ctx);
  private readonly wobble = this.ctx.createDelay(0.05);
  private readonly lfo = this.ctx.createOscillator();
  private readonly depth = this.ctx.createGain();
  private readonly aa = [this.ctx.createBiquadFilter(), this.ctx.createBiquadFilter()];

  constructor(ctx: AudioContext) {
    super(ctx);
    this.wobble.delayTime.value = 0.004;
    this.lfo.frequency.value = 0.67;
    this.lfo.connect(this.depth).connect(this.wobble.delayTime);
    this.lfo.start();
    // Two cascaded 2-pole low-passes for the "very sharp" 10 kHz anti-aliasing filters.
    for (const f of this.aa) {
      f.type = 'lowpass';
      f.frequency.value = MODEL200_BANDWIDTH;
      f.Q.value = 0.9;
    }
    this.send.connect(this.ir.node).connect(this.wobble).connect(this.aa[0]).connect(this.aa[1]);
    this.aa[1].connect(this.ret);
  }

  protected apply(p: Params) {
    const s = model200Settings(p);
    glide(this.depth.gain, s.modDepth, this.ctx, 0.1);
    this.ir.update(model200Key(s), (rate) => model200Impulse(s, rate));
  }

  override dispose() {
    this.ir.dispose();
    this.lfo.stop();
    super.dispose();
  }
}
