// DPS-R7 digital reverberator (see core/devices/dps-r7.ts for the sources and the maths).
//
//   in → INPUT ─┬→ DRY ──────────────────────────────────────────┐
//               └→ send → [impulse: early reflections + reverb / gate box] → 18 kHz → EFFECT ─┴→ out
//
// The front panel's separate DRY and EFFECT controls (p. 7, items 3–4) replace a MIX knob.

import { DPS_R7_BANDWIDTH, dpsR7Impulse, dpsR7Key, dpsR7Settings } from '../../core/devices/dps-r7';
import { type Params } from '../unit';
import { ImpulseConvolver } from './impulse-convolver';
import { RackUnit } from './rack-unit';

export class DpsR7Unit extends RackUnit {
  private readonly ir = new ImpulseConvolver(this.ctx);
  private readonly band = this.ctx.createBiquadFilter();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.band.type = 'lowpass';
    this.band.frequency.value = DPS_R7_BANDWIDTH;
    this.send.connect(this.ir.node).connect(this.band).connect(this.ret);
  }

  protected override balance(p: Params) {
    const s = dpsR7Settings(p);
    return { dry: s.dry, wet: s.effect };
  }

  protected apply(p: Params) {
    const s = dpsR7Settings(p);
    this.ir.update(dpsR7Key(s), (rate) => dpsR7Impulse(s, rate));
  }

  override dispose() {
    this.ir.dispose();
    super.dispose();
  }
}
