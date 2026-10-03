// Units for the pedals, mixer and output (the MS-20 has its own file). See `unit.ts`.

import { type DeviceKind, type GearKind } from '../core/gear';
import { driveCurve, expMap, faderGain, mixSends, panFor, reverbImpulse } from '../core/sound';
import { DEVICE_UNITS } from './devices';
import { Mf104Unit } from './mf104-unit';
import { ModelDUnit } from './modeld-unit';
import { Ms20Unit } from './ms20-unit';
import { Sh101Unit } from './sh101-unit';
import { Sp1200Unit } from './sp1200-unit';
import { type Params, Unit, glide } from './unit';

// ── Pedals ──────────────────────────────────────────────

/** Input → (dry | wet chain) → output, with true bypass from the footswitch. */
abstract class PedalUnit extends Unit {
  protected readonly in = this.ctx.createGain();
  protected readonly dry = this.ctx.createGain();
  protected readonly wet = this.ctx.createGain();
  protected readonly out = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.in;
    this.output = this.out;
    this.in.connect(this.dry).connect(this.out);
    this.wet.connect(this.out);
  }

  /** The dry / wet balance while engaged. */
  protected abstract sends(p: Params): { dry: number; wet: number };

  set(p: Params) {
    const on = p['bypass'] < 0.5;
    const s = on ? this.sends(p) : { dry: 1, wet: 0 };
    glide(this.dry.gain, s.dry, this.ctx, 0.01);
    glide(this.wet.gain, s.wet, this.ctx, 0.01);
  }
}

class OverdriveUnit extends PedalUnit {
  private readonly shaper = this.ctx.createWaveShaper();
  private readonly tone = this.ctx.createBiquadFilter();
  private readonly level = this.ctx.createGain();
  private drive = -1;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.shaper.oversample = '4x';
    this.tone.type = 'lowpass';
    this.in.connect(this.shaper).connect(this.tone).connect(this.level).connect(this.wet);
  }

  protected sends() {
    return { dry: 0, wet: 1 };
  }

  override set(p: Params) {
    super.set(p);
    if (Math.abs(p['drive'] - this.drive) > 0.005) {
      this.drive = p['drive'];
      this.shaper.curve = driveCurve(this.drive);
    }
    glide(this.tone.frequency, expMap(p['tone'], 600, 12000), this.ctx);
    // More drive is louder, so pull the output back as it rises.
    glide(this.level.gain, faderGain(p['level']) * (1 - p['drive'] * 0.5), this.ctx);
  }
}

class DelayUnit extends PedalUnit {
  private readonly delay = this.ctx.createDelay(2);
  private readonly feedback = this.ctx.createGain();
  private readonly damp = this.ctx.createBiquadFilter();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 5000;
    // Repeats darken as they circulate, like a tape or analog delay.
    this.in.connect(this.delay).connect(this.damp).connect(this.wet);
    this.damp.connect(this.feedback).connect(this.delay);
  }

  protected sends(p: Params) {
    return mixSends(p['mix']);
  }

  override set(p: Params) {
    super.set(p);
    glide(this.delay.delayTime, expMap(p['time'], 0.03, 1.2), this.ctx, 0.08);
    glide(this.feedback.gain, p['feedback'] * 0.9, this.ctx);
  }
}

class ReverbUnit extends PedalUnit {
  private readonly convolver = this.ctx.createConvolver();
  private readonly damp = this.ctx.createBiquadFilter();
  private size = -1;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.damp.type = 'lowpass';
    this.in.connect(this.convolver).connect(this.damp).connect(this.wet);
  }

  protected sends(p: Params) {
    return mixSends(p['mix']);
  }

  override set(p: Params) {
    super.set(p);
    glide(this.damp.frequency, expMap(1 - p['damp'], 1500, 16000), this.ctx);
    if (Math.abs(p['size'] - this.size) > 0.01) {
      // Building an impulse is a few hundred ms of noise, so wait for the knob to settle.
      const first = this.size < 0;
      this.size = p['size'];
      clearTimeout(this.timer);
      if (first) this.buildImpulse();
      else this.timer = setTimeout(() => this.buildImpulse(), 150);
    }
  }

  override dispose() {
    clearTimeout(this.timer);
    super.dispose();
  }

  private buildImpulse() {
    const rate = this.ctx.sampleRate;
    const channels = reverbImpulse(expMap(this.size, 0.3, 5), rate);
    const buffer = this.ctx.createBuffer(2, channels[0].length, rate);
    channels.forEach((data, i) => buffer.copyToChannel(data, i));
    this.convolver.buffer = buffer;
  }
}

class FilterUnit extends PedalUnit {
  private readonly filter = this.ctx.createBiquadFilter();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.filter.type = 'lowpass';
    this.in.connect(this.filter).connect(this.wet);
  }

  protected sends(p: Params) {
    return mixSends(p['mix']);
  }

  override set(p: Params) {
    super.set(p);
    glide(this.filter.frequency, expMap(p['cutoff'], 60, 16000), this.ctx);
    glide(this.filter.Q, 0.3 + p['reso'] * 24.7, this.ctx);
  }
}

// ── 4CH mixer ───────────────────────────────────────────

class MixerUnit extends Unit {
  private readonly channels: { pan: StereoPannerNode; level: GainNode }[] = [];
  private readonly bus = this.ctx.createGain();
  private readonly balance = this.ctx.createStereoPanner();
  private readonly out = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    for (let n = 1; n <= 4; n++) {
      const input = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const level = ctx.createGain();
      input.connect(pan).connect(level).connect(this.bus);
      this.inputs[`in${n}`] = input;
      this.channels.push({ pan, level });
      this.analyser(level);
    }
    this.bus.connect(this.balance).connect(this.out);
    this.analyser(this.balance); // not this.out: rewiring disconnects everything leaving it
    this.output = this.out;
  }

  set(p: Params) {
    this.channels.forEach((c, i) => {
      glide(c.pan.pan, panFor(p[`pan${i + 1}`]), this.ctx);
      glide(c.level.gain, faderGain(p[`level${i + 1}`]), this.ctx);
    });
    glide(this.balance.pan, panFor(p['pan5']), this.ctx);
    glide(this.bus.gain, faderGain(p['master']), this.ctx);
  }
}

// ── MULT ────────────────────────────────────────────────

/** One input copied to three outputs. Each output is its own node, so re-patching one jack
 * (which unplugs everything leaving that node) leaves the others connected. */
class MultUnit extends Unit {
  constructor(ctx: AudioContext) {
    super(ctx);
    const input = ctx.createGain();
    this.inputs['in'] = input;
    const tap = () => {
      const g = ctx.createGain();
      input.connect(g);
      return g;
    };
    this.output = tap();
    this.outs['out2'] = tap();
    this.outs['out3'] = tap();
  }

  set() {}
}

// ── MAIN • REC output ───────────────────────────────────

class OutputUnit extends Unit {
  private readonly volume = this.ctx.createGain();
  private readonly limiter = this.ctx.createDynamicsCompressor();

  constructor(ctx: AudioContext) {
    super(ctx);
    // A brick-wall-ish limiter so a wild patch can't blast the speakers.
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.inputs['in'] = this.volume;
    this.volume.connect(this.limiter).connect(ctx.destination);
    this.analyser(this.limiter);
  }

  set(p: Params) {
    glide(this.volume.gain, faderGain(p['volume']), this.ctx);
  }

  override dispose() {
    super.dispose();
    this.limiter.disconnect();
  }
}

export function createUnit(kind: GearKind, ctx: AudioContext): Unit {
  switch (kind) {
    case 'ms20':
      return new Ms20Unit(ctx);
    case 'modelD':
      return new ModelDUnit(ctx);
    case 'sh101':
      return new Sh101Unit(ctx);
    case 'mf104':
      return new Mf104Unit(ctx);
    case 'sp1200':
      return new Sp1200Unit(ctx);
    case 'mult':
      return new MultUnit(ctx);
    case 'overdrive':
      return new OverdriveUnit(ctx);
    case 'delay':
      return new DelayUnit(ctx);
    case 'reverb':
      return new ReverbUnit(ctx);
    case 'filter':
      return new FilterUnit(ctx);
    case 'mixer':
      return new MixerUnit(ctx);
    case 'output':
      return new OutputUnit(ctx);
    default:
      return DEVICE_UNITS[kind as DeviceKind](ctx);
  }
}
