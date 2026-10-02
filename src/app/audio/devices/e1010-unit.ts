// E1010 analog delay, following the service manual's block diagram (p. 6):
//
//   send → BASS / TREBLE → (+) → overload → 13 kHz LPF → BBD line → 13 kHz LPF ─┬→ passive LPF → ret
//                           ↑                                                  │
//                           └──────────────────── FEEDBACK ←───────────────────┘
//   triangle LFO (FREQUENCY) → DEPTH → BBD clock (the line's delay time)
//
// The bucket-brigade chain becomes one DelayNode whose delay is the tapped stage count over twice
// the clock; the NE570 compander and pre/de-emphasis are left out (they exist to hide BBD noise,
// which a DelayNode doesn't have). The −24 dB/oct 13 kHz filters are 4-pole Butterworths. A
// unity-gain soft clip in the loop stands in for the line's overload, so FEEDBACK can pass unity.

import { HEADROOM, softClipCurve } from '../../core/mf104';
import { BUTTERWORTH4, qDb } from '../../core/devices/filter-math';
import { type E1010Settings, e1010Settings } from '../../core/devices/e1010';
import { type Params, glide } from '../unit';
import { RackUnit } from './rack-unit';

const FILTER_HZ = 13e3; // fc = 13 kHz, −24 dB/oct (p. 6)

export class E1010Unit extends RackUnit {
  private s?: E1010Settings;
  private readonly bass = this.filter('lowshelf', 70);
  private readonly treble = this.filter('highshelf', 7000);
  private readonly loopSum = this.ctx.createGain();
  private readonly overloadIn = this.ctx.createGain();
  private readonly overload = this.ctx.createWaveShaper();
  private readonly line = this.ctx.createDelay(0.5);
  private readonly delayed = this.ctx.createGain();
  private readonly feedback = this.ctx.createGain();
  private readonly outFilter = this.filter('lowpass', 20000);
  private readonly lfo = this.ctx.createOscillator();
  private readonly modDepth = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.overloadIn.gain.value = 1 / HEADROOM;
    this.overload.curve = softClipCurve();
    this.overload.oversample = '2x';

    this.send.connect(this.bass).connect(this.treble).connect(this.loopSum);
    this.loopSum.connect(this.overloadIn).connect(this.overload);
    let node: AudioNode = this.overload;
    for (const q of BUTTERWORTH4) node = node.connect(this.filter('lowpass', FILTER_HZ, q));
    node = node.connect(this.line);
    for (const q of BUTTERWORTH4) node = node.connect(this.filter('lowpass', FILTER_HZ, q));
    node.connect(this.delayed);
    this.delayed.connect(this.feedback).connect(this.loopSum);
    this.delayed.connect(this.outFilter).connect(this.ret);

    this.lfo.type = 'triangle';
    this.lfo.connect(this.modDepth).connect(this.line.delayTime);
    this.lfo.start();
  }

  protected apply(p: Params) {
    const first = !this.s;
    const s = (this.s = e1010Settings(p));
    const ctx = this.ctx;
    glide(this.bass.gain, s.bassDb, ctx);
    glide(this.treble.gain, s.trebleDb, ctx);
    glide(this.feedback.gain, s.feedback, ctx);
    // The clock slews when DELAY moves (or a range button changes the tap), bending the pitch.
    if (first) this.line.delayTime.value = s.seconds;
    else glide(this.line.delayTime, s.seconds, ctx, 0.08);
    glide(this.lfo.frequency, s.rateHz, ctx);
    glide(this.modDepth.gain, s.modDepth, ctx);
    glide(this.outFilter.frequency, s.outFilter?.hz ?? 20000, ctx);
    glide(this.outFilter.Q, qDb(s.outFilter?.q ?? Math.SQRT1_2), ctx);
  }

  override dispose() {
    this.lfo.stop();
    super.dispose();
  }

  private filter(type: BiquadFilterType, hz: number, q = Math.SQRT1_2) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = qDb(q);
    return f;
  }
}
