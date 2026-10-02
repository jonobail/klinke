// REV5 digital reverberator (see core/devices/rev5.ts for the sources and the maths).
//
//   send → mono sum → analog EQ (LO shelf / MID peak / HI shelf, EQ ON) → [impulse: early
//        reflections + tail] → ret
//
// As on the block diagram (p. 4) the input is summed to one A/D channel and the EQ sits before
// it, so it shapes only the reverb; MIXING then blends the processed and direct sound.

import { rev5Impulse, rev5Key, rev5Settings } from '../../core/devices/rev5';
import { type Params, glide } from '../unit';
import { ImpulseConvolver } from './impulse-convolver';
import { RackUnit } from './rack-unit';

export class Rev5Unit extends RackUnit {
  private readonly mono = this.ctx.createGain();
  private readonly lo = this.ctx.createBiquadFilter();
  private readonly mid = this.ctx.createBiquadFilter();
  private readonly hi = this.ctx.createBiquadFilter();
  private readonly ir = new ImpulseConvolver(this.ctx);

  constructor(ctx: AudioContext) {
    super(ctx);
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.lo.type = 'lowshelf';
    this.mid.type = 'peaking';
    this.mid.Q.value = 0.9;
    this.hi.type = 'highshelf';
    this.send.connect(this.mono).connect(this.lo).connect(this.mid).connect(this.hi);
    this.hi.connect(this.ir.node).connect(this.ret);
  }

  protected apply(p: Params) {
    const s = rev5Settings(p);
    for (const [f, band] of [
      [this.lo, s.lo],
      [this.mid, s.mid],
      [this.hi, s.hi],
    ] as const) {
      glide(f.frequency, band.hz, this.ctx);
      glide(f.gain, s.eqOn ? band.db : 0, this.ctx);
    }
    this.ir.update(rev5Key(s), (rate) => rev5Impulse(s, rate));
  }

  override dispose() {
    this.ir.dispose();
    super.dispose();
  }
}
