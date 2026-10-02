// Shared plumbing for rack effects:
//
//   in → INPUT level ─┬→ dry ────────────────┐
//                     └→ send → [effect] → ret → wet ─┴→ OUTPUT level → out
//
// A device builds its effect between `send` and `ret` and implements `apply(params)`. The base
// handles BYPASS (dry through, effect muted) and, if the device has a `mix` param, the
// equal-power MIX; devices without one are 100 % wet (override `balance` to change that). If the
// device has `input` / `output` params they set the levels (0.75 is unity; see `faderGain`).
// Meters: channel 0 reads the effect input, channel 1 the effect return (for level LEDs).

import { faderGain, mixSends } from '../../core/sound';
import { type Params, Unit, glide } from '../unit';

export abstract class RackUnit extends Unit {
  protected readonly in = this.ctx.createGain();
  protected readonly inputLevel = this.ctx.createGain();
  protected readonly dry = this.ctx.createGain();
  /** Feed the effect from here… */
  protected readonly send = this.ctx.createGain();
  /** …and return it here. */
  protected readonly ret = this.ctx.createGain();
  protected readonly wet = this.ctx.createGain();
  protected readonly outputLevel = this.ctx.createGain();
  protected readonly out = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.in;
    this.output = this.out;
    this.in.connect(this.inputLevel);
    this.inputLevel.connect(this.dry).connect(this.outputLevel);
    this.inputLevel.connect(this.send);
    this.ret.connect(this.wet).connect(this.outputLevel);
    this.outputLevel.connect(this.out);
    this.analyser(this.send);
    this.analyser(this.ret);
  }

  /** Sets up the effect for these params. Called on every change, so keep it cheap. */
  protected abstract apply(p: Params): void;

  /** Dry / wet balance while engaged. */
  protected balance(p: Params): { dry: number; wet: number } {
    return 'mix' in p ? mixSends(p['mix']) : { dry: 0, wet: 1 };
  }

  set(p: Params) {
    const bypass = p['bypass'] >= 0.5;
    const { dry, wet } = this.balance(p);
    glide(this.dry.gain, bypass ? 1 : dry, this.ctx, 0.01);
    glide(this.wet.gain, bypass ? 0 : wet, this.ctx, 0.01);
    glide(this.send.gain, bypass ? 0 : 1, this.ctx, 0.01);
    glide(this.inputLevel.gain, 'input' in p ? faderGain(p['input']) : 1, this.ctx);
    glide(this.outputLevel.gain, 'output' in p ? faderGain(p['output']) : 1, this.ctx);
    this.apply(p);
  }
}
