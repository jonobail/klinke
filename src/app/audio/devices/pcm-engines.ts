// Effect engines shared by the PCM-70 and PCM-80 units (the maths is in
// core/devices/pcm-dsp.ts):
//
//   ReverbEngine  in → pre-delay → room impulse (two convolvers, crossfaded when the room changes)
//                 → spin (L / R delays swept in anti-phase) → out; optional tempo echoes into the room
//   TapEngine     in → diffuser → taps (DelayNode → loop low-pass → band) → pan → out, the taps fed
//                 back through a self / ring / cascade network, each swept by its own-phase LFO
//   ChordEngine   in → strum delays → six tuned combs (DelayNode → low-pass → feedback) → pan → out
//   EngineSlot    holds the running engine and swaps it with a short mute, like the hardware's
//                 MUTE on a program change (PCM-70 service packet §4.1.4)

import {
  type ChordSettings,
  type ReverbSettings,
  type TapSettings,
  chordHz,
  combDelay,
  combFeedback,
  diffusionBurst,
  irSeconds,
  links,
  roomImpulse,
} from '../../core/devices/pcm-dsp';
import { glide } from '../unit';

export abstract class Engine {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly owned: AudioNode[] = [];
  private readonly oscs: OscillatorNode[] = [];
  protected timer?: ReturnType<typeof setTimeout>;

  constructor(protected readonly ctx: AudioContext) {
    this.input = this.gain();
    this.output = this.gain();
  }

  dispose() {
    clearTimeout(this.timer);
    for (const o of this.oscs) o.stop();
    for (const n of this.owned) n.disconnect();
  }

  protected own<T extends AudioNode>(n: T): T {
    this.owned.push(n);
    return n;
  }

  protected gain(value = 1) {
    const g = this.own(this.ctx.createGain());
    g.gain.value = value;
    return g;
  }

  protected delay(max: number, value = 0) {
    const d = this.own(this.ctx.createDelay(max));
    d.delayTime.value = value;
    return d;
  }

  /**
   * A biquad. A low-pass's Q is in dB in Web Audio: -3.01 dB is Butterworth (no peak), which keeps
   * every feedback loop's gain at or below its FEEDBACK setting. A band-pass's Q is linear.
   */
  protected filter(type: BiquadFilterType, hz: number, q = type === 'lowpass' ? -3.0103 : 1) {
    const f = this.own(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    return f;
  }

  /** A sine LFO starting at `phase` (0–1 of a cycle). */
  protected lfo(phase: number, hz: number) {
    const o = this.own(this.ctx.createOscillator());
    const a = 2 * Math.PI * phase;
    // sin(ωt + a) = sin a · cos ωt + cos a · sin ωt
    o.setPeriodicWave(
      this.ctx.createPeriodicWave([0, Math.sin(a)], [0, Math.cos(a)], {
        disableNormalization: true,
      }),
    );
    o.frequency.value = hz;
    o.start();
    this.oscs.push(o);
    return o;
  }

  protected buffer(channels: Float32Array<ArrayBuffer>[]) {
    const b = this.ctx.createBuffer(channels.length, channels[0].length, this.ctx.sampleRate);
    channels.forEach((data, i) => b.copyToChannel(data, i));
    return b;
  }
}

/** Generated-impulse reverb (halls, chambers, plates, inverse rooms). */
export class ReverbEngine extends Engine {
  private readonly pre = this.delay(1);
  private readonly rooms = [0, 1].map(() => {
    const c = this.own(this.ctx.createConvolver());
    c.normalize = false;
    const g = this.gain(0);
    this.pre.connect(c).connect(g);
    return { c, g };
  });
  private live = 1;
  private key = '';
  private readonly spin = [this.delay(0.05, 0.008), this.delay(0.05, 0.008)];
  private readonly spinDepth = [this.gain(0), this.gain(0)];
  private readonly spinLfo = this.lfo(0, 0.5);
  private readonly echo?: { taps: DelayNode[]; fb: GainNode; level: GainNode };

  constructor(ctx: AudioContext, echoes = false) {
    super(ctx);
    this.input.connect(this.pre);
    const sum = this.gain();
    for (const r of this.rooms) r.g.connect(sum);
    // Spin: left and right swept in anti-phase, a slow wander on the tail.
    const split = this.own(ctx.createChannelSplitter(2));
    const merge = this.own(ctx.createChannelMerger(2));
    sum.connect(split);
    this.spin.forEach((d, ch) => {
      split.connect(d, ch);
      d.connect(merge, 0, ch);
      this.spinLfo.connect(this.spinDepth[ch]).connect(d.delayTime);
    });
    merge.connect(this.output);
    if (echoes) {
      // Two echo taps a beat apart, regenerating through each other: L, R, L… into the room.
      const taps = [this.delay(4), this.delay(4)];
      const fb = this.gain(0);
      const level = this.gain(0);
      const pans = [-0.8, 0.8].map((x) => {
        const p = this.own(ctx.createStereoPanner());
        p.pan.value = x;
        return p;
      });
      this.input.connect(taps[0]).connect(taps[1]).connect(fb).connect(taps[0]);
      taps.forEach((t, i) => t.connect(pans[i]).connect(level));
      level.connect(this.pre);
      level.connect(this.output);
      this.echo = { taps, fb, level };
    }
  }

  set(s: ReverbSettings) {
    const ctx = this.ctx;
    glide(this.pre.delayTime, s.predelay, ctx, 0.05);
    glide(this.spinDepth[0].gain, s.depth, ctx);
    glide(this.spinDepth[1].gain, -s.depth, ctx);
    glide(this.spinLfo.frequency, s.rate, ctx);
    if (this.echo && s.echo) {
      for (const t of this.echo.taps) glide(t.delayTime, s.echo.time, ctx, 0.05);
      glide(this.echo.fb.gain, s.echo.feedback, ctx);
      glide(this.echo.level.gain, s.echo.level, ctx);
    }
    // Only a change to the room's shape needs a new impulse; wait for the knob to settle.
    const r = s.room;
    const key = [r.shape, r.rt.toFixed(2), r.bassMult.toFixed(2), Math.round(r.trebleHz)]
      .concat([r.size.toFixed(1), (r.slope ?? 0).toFixed(0)])
      .join('|');
    if (key === this.key) return;
    const first = !this.key;
    this.key = key;
    clearTimeout(this.timer);
    if (first) this.build(s);
    else this.timer = setTimeout(() => this.build(s), 150);
  }

  /** Loads the new impulse into the idle convolver and crossfades to it. */
  private build(s: ReverbSettings) {
    const next = 1 - this.live;
    const { c, g } = this.rooms[next];
    const old = this.rooms[this.live].g;
    c.buffer = this.buffer(roomImpulse(s.room, this.ctx.sampleRate));
    const t = this.ctx.currentTime;
    const fade = Math.min(0.3, irSeconds(s.room) / 4);
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(1, t + fade);
    old.gain.cancelScheduledValues(t);
    old.gain.setValueAtTime(old.gain.value, t);
    old.gain.linearRampToValueAtTime(0, t + fade);
    this.live = next;
  }
}

/** Chorus, flange, echoes and multiband delays: a network of modulated taps. */
export class TapEngine extends Engine {
  private readonly direct = this.gain();
  private readonly diffused = this.gain(0);
  private readonly voices: {
    delay: DelayNode;
    tone: BiquadFilterNode;
    depth: GainNode;
    lfo: OscillatorNode;
    send: GainNode;
    sum: GainNode;
    pan: StereoPannerNode;
    band?: BiquadFilterNode;
  }[];
  private readonly loops: { gain: GainNode; feedback: boolean }[] = [];
  private first = true;

  constructor(ctx: AudioContext, s: TapSettings) {
    super(ctx);
    const into = this.gain();
    const diffuser = this.own(ctx.createConvolver());
    diffuser.normalize = false;
    diffuser.buffer = this.buffer(diffusionBurst(ctx.sampleRate));
    this.input.connect(this.direct).connect(into);
    this.input.connect(diffuser).connect(this.diffused).connect(into);
    const level = this.gain(1.2 / Math.sqrt(s.taps.length));
    level.connect(this.output);
    this.voices = s.taps.map((tap) => {
      const sum = this.gain();
      const send = this.gain(tap.send);
      const delay = this.delay(5, tap.time);
      const tone = this.filter('lowpass', s.toneHz);
      into.connect(send).connect(sum).connect(delay).connect(tone);
      const pan = this.own(ctx.createStereoPanner());
      pan.pan.value = tap.pan;
      // The band filter sits outside the loop, so a cascade isn't band-passed to nothing.
      const band = tap.band ? this.filter('bandpass', tap.band, s.bandQ ?? 1.4) : undefined;
      (band ? tone.connect(band) : tone).connect(pan).connect(level);
      const lfo = this.lfo(tap.phase, s.rate);
      const depth = this.gain(0);
      lfo.connect(depth).connect(delay.delayTime);
      return { delay, tone, depth, lfo, send, sum, pan, band };
    });
    // The feedback network: each tap is fed by at most one link (see `links`, `loopGain`).
    for (const l of links(s.topology, s.taps.length)) {
      const gain = this.gain(0);
      this.voices[l.from].tone.connect(gain).connect(this.voices[l.to].sum);
      this.loops.push({ gain, feedback: l.feedback });
    }
  }

  set(s: TapSettings) {
    const ctx = this.ctx;
    // First call lands at once; later moves glide, so a delay-time change bends like tape.
    const t = this.first ? 0.001 : 0.08;
    this.first = false;
    s.taps.forEach((tap, i) => {
      const v = this.voices[i];
      if (!v) return;
      glide(v.delay.delayTime, tap.time, ctx, t);
      glide(v.tone.frequency, s.toneHz, ctx);
      glide(v.depth.gain, s.depth, ctx);
      glide(v.lfo.frequency, s.rate, ctx);
      glide(v.pan.pan, tap.pan, ctx);
      glide(v.send.gain, tap.send, ctx);
      if (v.band) glide(v.band.Q, s.bandQ ?? 1.4, ctx);
    });
    for (const l of this.loops) glide(l.gain.gain, l.feedback ? s.feedback : 1, ctx);
    glide(this.direct.gain, 1 - s.diffusion, ctx);
    glide(this.diffused.gain, s.diffusion, ctx);
  }
}

/** Chorus into a room (PCM-80 Chorus-Verb): VERB sets how much of the chorus goes through it. */
export class ChorusVerbEngine extends Engine {
  readonly chorus: TapEngine;
  readonly room: ReverbEngine;
  private readonly dry = this.gain();
  private readonly verb = this.gain(0);

  constructor(ctx: AudioContext, taps: TapSettings) {
    super(ctx);
    this.chorus = new TapEngine(ctx, taps);
    this.room = new ReverbEngine(ctx);
    this.input.connect(this.chorus.input);
    this.chorus.output.connect(this.dry).connect(this.output);
    this.chorus.output.connect(this.room.input);
    this.room.output.connect(this.verb).connect(this.output);
  }

  set(taps: TapSettings, room: ReverbSettings, verb: number) {
    this.chorus.set(taps);
    this.room.set(room);
    glide(this.dry.gain, Math.cos((verb * Math.PI) / 2), this.ctx);
    glide(this.verb.gain, Math.sin((verb * Math.PI) / 2), this.ctx);
  }

  override dispose() {
    this.chorus.dispose();
    this.room.dispose();
    super.dispose();
  }
}

/** Resonant chords: six combs tuned to a chord, rung by the input. */
export class ChordEngine extends Engine {
  private static readonly SPREAD = [0, 1, -1, 0.5, -0.5, 0.75];
  private static readonly PAN = [0, -1, 1, -0.5, 0.5, -0.2];
  private readonly voices = ChordEngine.SPREAD.map((_, i) => {
    const strum = this.delay(1);
    const drive = this.gain(0);
    const sum = this.gain();
    const comb = this.delay(0.1, 0.01);
    const tone = this.filter('lowpass', 4000);
    const fb = this.gain(0);
    const pan = this.own(this.ctx.createStereoPanner());
    this.input.connect(strum).connect(drive).connect(sum).connect(comb).connect(tone);
    tone.connect(fb).connect(sum);
    tone.connect(pan).connect(this.output);
    pan.pan.value = ChordEngine.PAN[i];
    return { strum, drive, comb, tone, fb, pan, index: i };
  });

  set(s: ChordSettings) {
    const ctx = this.ctx;
    const hz = chordHz(s.root, s.steps, ctx.sampleRate, s.toneHz);
    for (const v of this.voices) {
      const f = hz[v.index] * Math.pow(2, (s.detune * ChordEngine.SPREAD[v.index]) / 1200);
      const g = combFeedback(1 / f, s.decay);
      glide(v.comb.delayTime, combDelay(f, s.toneHz), ctx, 0.03);
      glide(v.tone.frequency, s.toneHz, ctx);
      glide(v.fb.gain, g, ctx);
      // A comb peaks at 1 / (1 - g); scale its input so every voice rings at a similar level.
      glide(v.drive.gain, (1 - g) * 2.5, ctx);
      glide(v.strum.delayTime, s.strum * v.index, ctx);
      glide(v.pan.pan, s.width * ChordEngine.PAN[v.index], ctx);
    }
  }
}

/**
 * The engine that's running. Swapping fades the old one out, mutes briefly, then fades the new one
 * in, the way the hardware mutes its converters while a program loads.
 */
export class EngineSlot<E extends Engine> {
  current?: E;
  key = '';
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly from: AudioNode,
    private readonly to: AudioNode,
  ) {}

  /** The engine for `key`, building a new one (and retiring the old) if the key changed. */
  use(key: string, make: () => E): E {
    if (this.current && key === this.key) return this.current;
    const old = this.current;
    const t = this.ctx.currentTime;
    if (old) {
      old.output.gain.setTargetAtTime(0, t, 0.01);
      this.later(() => {
        this.from.disconnect(old.input);
        old.dispose();
      }, 120);
    }
    const e = make();
    e.output.gain.value = 0;
    this.from.connect(e.input);
    e.output.connect(this.to);
    e.output.gain.setTargetAtTime(1, t + (old ? 0.06 : 0), 0.02);
    this.current = e;
    this.key = key;
    return e;
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.current?.dispose();
  }

  private later(f: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      f();
    }, ms);
    this.timers.add(t);
  }
}
