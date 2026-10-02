// MF-104 analog delay, following the schematics (BRD-10-011-360 rev E):
//
//   in → DRIVE preamp (soft clip) ─┬──────────────────────────────── dry ─┐
//                                  └→ anti-alias LPF → BBD delay line →    │
//                                     reconstruction LPF ─┬─ wet ──────────┴→ MIX → OUTPUT → out
//                                            ↑            ├→ LOOP OUT
//                                       FEEDBACK  ←───────┘ (INT)  or  LOOP IN × LOOP GAIN (EXT)
//
// The bucket-brigade line becomes a DelayNode; turning TIME glides its delay, so the pitch bends
// the way a BBD's does when its clock moves. The SA572 compander is left out (it's there to hide
// BBD noise, which a DelayNode doesn't have); a unity-gain soft clip in the loop stands in for
// the line's overload, which is what lets FEEDBACK past unity build into controlled runaway.

import { HEADROOM, type Mf104Settings, mf104Settings, softClipCurve } from '../core/mf104';
import { type Params, Unit, glide } from './unit';

export class Mf104Unit extends Unit {
  private s?: Mf104Settings;

  private readonly in = this.ctx.createGain();
  private readonly preamp = this.ctx.createGain();
  private readonly driven = this.clipper();
  private readonly dry = this.ctx.createGain();
  private readonly send = this.ctx.createGain();
  private readonly loopSum = this.ctx.createGain();
  private readonly antiAlias = [this.lowpass(), this.lowpass()];
  private readonly line = this.ctx.createDelay(2);
  private readonly reconstruct = [this.lowpass(), this.lowpass()];
  private readonly delayed = this.ctx.createGain();
  private readonly wet = this.ctx.createGain();
  private readonly loopOut = this.ctx.createGain();
  private readonly internal = this.ctx.createGain();
  private readonly loopIn = this.ctx.createGain();
  private readonly loopGain = this.ctx.createGain();
  private readonly feedback = this.ctx.createGain();
  private readonly overload = this.clipper();
  private readonly mixed = this.ctx.createGain();
  private readonly level = this.ctx.createGain();
  private readonly bypassed = this.ctx.createGain();
  private readonly out = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.in;
    this.inputs['loopIn'] = this.loopIn;
    // Its own node: re-patching unplugs everything leaving an output, which mustn't cut the loop.
    this.outs['loopOut'] = this.loopOut;
    this.output = this.out;

    // Preamp → dry, and → the delay line
    this.in.connect(this.preamp).connect(this.driven.input);
    this.analyser(this.preamp); // the DRIVE LED reads the preamp before it clips
    this.driven.output.connect(this.dry).connect(this.mixed);
    this.driven.output.connect(this.send).connect(this.loopSum);

    // Line: loop sum → overload → anti-alias → delay → reconstruction
    this.loopSum.connect(this.overload.input);
    let node: AudioNode = this.overload.output;
    for (const f of [...this.antiAlias]) node = node.connect(f);
    node = node.connect(this.line);
    for (const f of this.reconstruct) node = node.connect(f);
    node.connect(this.delayed);
    this.delayed.connect(this.wet).connect(this.mixed);
    this.delayed.connect(this.loopOut);

    // Feedback: the delayed signal (INT) or whatever comes back on LOOP IN (EXT)
    this.delayed.connect(this.internal).connect(this.feedback);
    this.loopIn.connect(this.loopGain).connect(this.feedback);
    this.feedback.connect(this.loopSum);
    this.analyser(this.feedback); // the LOOP LED

    this.mixed.connect(this.level).connect(this.out);
    this.in.connect(this.bypassed).connect(this.out);
  }

  set(p: Params) {
    const first = !this.s;
    const s = (this.s = mf104Settings(p));
    const ctx = this.ctx;
    const on = s.bypass ? 0 : 1;

    glide(this.preamp.gain, s.drive, ctx);
    if (first) this.line.delayTime.value = s.seconds;
    // A BBD's clock slews when TIME moves, sliding the pitch of what's in the line.
    else glide(this.line.delayTime, s.seconds, ctx, 0.12);
    for (const f of [...this.antiAlias, ...this.reconstruct]) glide(f.frequency, s.filterHz, ctx);

    glide(this.internal.gain, s.extLoop ? 0 : 1, ctx, 0.01);
    glide(this.loopGain.gain, s.extLoop ? s.loopGain : 0, ctx, 0.01);
    glide(this.feedback.gain, s.feedback * on, ctx);

    // True bypass: the footswitch routes the input straight out and mutes the delay.
    glide(this.send.gain, on, ctx, 0.01);
    glide(this.dry.gain, s.dry * on, ctx, 0.01);
    glide(this.wet.gain, s.wet * on, ctx, 0.01);
    glide(this.level.gain, s.output, ctx);
    glide(this.bypassed.gain, 1 - on, ctx, 0.01);
  }

  private lowpass() {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    // Web Audio's low-pass Q is in dB: −3.01 dB is Butterworth (no peak), like the Sallen–Keys.
    f.Q.value = -3.01;
    return f;
  }

  /** A unity-gain tanh soft clip (see `softClipCurve`). */
  private clipper() {
    const input = this.ctx.createGain();
    const shaper = this.ctx.createWaveShaper();
    input.gain.value = 1 / HEADROOM;
    shaper.curve = softClipCurve();
    shaper.oversample = '2x';
    input.connect(shaper);
    return { input, output: shaper };
  }
}
