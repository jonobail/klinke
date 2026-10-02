// DELTA-T digital delay, following the schematics (see core/devices/delta-t.ts for the sheets):
//
//   send → 15 kHz input filter → (+) → gain-ranged 12-bit ADC/DAC ─┬→ tap 1 → 15 kHz → LEVEL 1 ─┬→ ret
//                                 ↑                                ├→ tap 2 → 15 kHz → LEVEL 2 ─┤
//                                 └─────── REGEN ←── tap 1         └→ tap 3 → 15 kHz → LEVEL 3 ─┘
//   VCO (sine / triangle / square, FREQ, AMPL) → every tap's delay, in proportion to its length
//
// The shift-register memory becomes one DelayNode per output module (each reads the same memory at
// its own tap). Moving the master clock scales every tap together, which is what the VCO-102 does;
// the converters are a WaveShaper with the gain-ranged 12-bit staircase.

import { BUTTERWORTH4, qDb } from '../../core/devices/filter-math';
import { type DeltaTSettings, deltaTSettings, quantiseCurve } from '../../core/devices/delta-t';
import { type Params, glide } from '../unit';
import { RackUnit } from './rack-unit';

const FILTER_HZ = 15e3; // INP-01 / OM-102, B, C and S versions (p. 1, p. 2 tables)
const MAX_DELAY = 0.45; // 192 ms × 2 (VCO at 2.21 MHz) + modulation

export class DeltaTUnit extends RackUnit {
  private s?: DeltaTSettings;
  /** Alternates the two Butterworth section Qs as filters are made in pairs. */
  private flip = 0;
  private readonly sum = this.ctx.createGain();
  private readonly converters = this.ctx.createWaveShaper();
  private readonly taps = [0, 1, 2].map(() => this.ctx.createDelay(MAX_DELAY));
  private readonly levels = [0, 1, 2].map(() => this.ctx.createGain());
  private readonly regen = this.ctx.createGain();
  private readonly vco = this.ctx.createOscillator();
  private readonly smoothing = this.ctx.createBiquadFilter();
  private readonly modBus = this.ctx.createGain();
  private readonly modTaps = [0, 1, 2].map(() => this.ctx.createGain());

  constructor(ctx: AudioContext) {
    super(ctx);
    this.converters.curve = quantiseCurve();
    this.send.connect(this.lowpass()).connect(this.lowpass()).connect(this.sum);
    this.sum.connect(this.converters);
    this.taps.forEach((tap, i) => {
      this.converters.connect(tap);
      const out = tap.connect(this.lowpass()).connect(this.lowpass());
      out.connect(this.levels[i]).connect(this.ret);
      if (i === 0) out.connect(this.regen).connect(this.sum);
    });

    this.smoothing.type = 'lowpass';
    this.smoothing.Q.value = qDb(Math.SQRT1_2);
    this.vco.connect(this.smoothing).connect(this.modBus);
    this.modTaps.forEach((g, i) => this.modBus.connect(g).connect(this.taps[i].delayTime));
    this.vco.start();
  }

  protected apply(p: Params) {
    const first = !this.s;
    const prev = this.s;
    const s = (this.s = deltaTSettings(p));
    const ctx = this.ctx;
    s.taps.forEach((t, i) => {
      // The output modules switch taps; a short glide keeps a switch change from clicking.
      if (first) this.taps[i].delayTime.value = t;
      else if (t !== prev!.taps[i]) glide(this.taps[i].delayTime, t, ctx, 0.03);
      glide(this.modTaps[i].gain, t, ctx);
      glide(this.levels[i].gain, s.levels[i], ctx);
    });
    glide(this.regen.gain, s.regen, ctx);
    const type: OscillatorType =
      s.mode === 'SINE' ? 'sine' : s.mode === 'SQUARE' ? 'square' : 'triangle';
    if (this.vco.type !== type) this.vco.type = type;
    glide(this.vco.frequency, s.rateHz, ctx);
    glide(this.smoothing.frequency, s.smoothingHz, ctx);
    glide(this.modBus.gain, s.modFraction, ctx);
  }

  override dispose() {
    this.vco.stop();
    super.dispose();
  }

  private lowpass() {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = FILTER_HZ;
    f.Q.value = qDb(BUTTERWORTH4[this.flip++ % 2]);
    return f;
  }
}
