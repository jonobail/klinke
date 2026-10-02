// DPS-V55: two effect blocks, FxA and FxB, in parallel or in series (manual p.8):
//
//   send ─┬→ FxA ─┬────────────── (parallel) ──┬→ ret
//         │       └→ (serial) ─┐               │
//         └──── (parallel) ────┴→ FxB ─────────┘
//
// Each block is an effect from the Effect Parameter Guide with its own direct / effect balance
// (dps-engines.ts); changing the effect crossfades to the new one. The master Level is the
// base `output`.

import { v55Settings } from '../../core/devices/dps-v55';
import { type Params, glide } from '../unit';
import { FxBlock } from './dps-engines';
import { RackUnit } from './rack-unit';

export class DpsV55Unit extends RackUnit {
  private readonly fxA = new FxBlock(this.ctx);
  private readonly fxB = new FxBlock(this.ctx);
  private readonly aToB = this.ctx.createGain();
  private readonly inToB = this.ctx.createGain();
  private readonly aOut = this.ctx.createGain();
  private readonly bOut = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.send.connect(this.fxA.input);
    this.fxA.output.connect(this.aToB).connect(this.fxB.input);
    this.send.connect(this.inToB).connect(this.fxB.input);
    this.fxA.output.connect(this.aOut).connect(this.ret);
    this.fxB.output.connect(this.bOut).connect(this.ret);
  }

  protected apply(p: Params) {
    const s = v55Settings(p);
    this.fxA.set(s.a, s.aKnobs, s.aBal);
    this.fxB.set(s.b, s.bKnobs, s.bBal);
    // Without an FxB the block passes straight through, so treat it as serial.
    const serial = s.serial || !s.b;
    const ctx = this.ctx;
    glide(this.aToB.gain, serial ? 1 : 0, ctx, 0.02);
    glide(this.inToB.gain, serial ? 0 : 1, ctx, 0.02);
    // In parallel both blocks carry their direct sound; 0.7 each keeps the sum near unity.
    glide(this.aOut.gain, serial ? 0 : 0.7, ctx, 0.02);
    glide(this.bOut.gain, serial ? 1 : 0.7, ctx, 0.02);
  }

  override dispose() {
    this.fxA.dispose();
    this.fxB.dispose();
    super.dispose();
  }
}
