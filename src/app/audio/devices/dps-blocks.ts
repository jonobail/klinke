// Web Audio building blocks shared by the DPS-series units (DPS-D7, DPS-M7, DPS-V55, DPS-V77):
// LFOs, modulated-delay voices (chorus / flanger / vibrato), a stereo feedback delay with tone in
// the loop, crossfading convolvers for tap patterns and reverbs, phaser, tremolo, panners, a
// two-tap pitch shifter, ring modulator, rotary speaker, EQ, dynamics, gate and envelope follower.
// Native nodes only; every feedback loop runs through a DelayNode and a unity-gain soft clip.
// The maths (wave shapes, pitch plan, impulse responses) lives in core/devices/dps-dsp.ts.

import {
  type Harmonics,
  type Tap,
  type Wave,
  absCurve,
  clamp,
  gateCurve,
  pitchPlan,
  reverbIR,
  sawHarmonics,
  shiftHarmonics,
  tanhCurve,
  tapIR,
  waveHarmonics,
  windowHarmonics,
} from '../../core/devices/dps-dsp';
import { driveCurve } from '../../core/sound';
import { glide } from '../unit';

/** A piece of signal processing: audio in, audio out. */
export interface Block {
  readonly input: AudioNode;
  readonly output: AudioNode;
  dispose(): void;
}

const HEADROOM = 4;

/** Caches PeriodicWaves per context: the same shape is built once. */
const waves = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
export function periodicWave(ctx: BaseAudioContext, key: string, make: () => Harmonics) {
  let m = waves.get(ctx);
  if (!m) waves.set(ctx, (m = new Map()));
  let w = m.get(key);
  if (!w) {
    const h = make();
    w = ctx.createPeriodicWave(Float32Array.from(h.a), Float32Array.from(h.b), {
      disableNormalization: true,
    });
    m.set(key, w);
  }
  return w;
}

/**
 * An LFO: a PeriodicWave oscillator (sin / tri / special 1 / special 2) into a depth gain. LFOs
 * created in the same task start together, so a second one with a phase offset stays locked to
 * the first (the M7's "LFO phase (ch1, ch2)").
 */
export class Lfo {
  readonly osc: OscillatorNode;
  /** Wave × depth; connect it to the AudioParams it modulates. */
  readonly out: GainNode;
  private key = '';

  constructor(
    private readonly ctx: BaseAudioContext,
    wave: Wave = 0,
    phase = 0,
  ) {
    this.osc = ctx.createOscillator();
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.shape(wave, phase);
    this.osc.connect(this.out);
    this.osc.start();
  }

  shape(wave: Wave, phase: number) {
    const deg = Math.round(((phase % 360) + 360) % 360);
    const key = `w${wave}p${deg}`;
    if (key === this.key) return;
    this.key = key;
    this.osc.setPeriodicWave(
      periodicWave(this.ctx, key, () => shiftHarmonics(waveHarmonics(wave), deg)),
    );
  }

  rate(hz: number, time = 0.05) {
    glide(this.osc.frequency, hz, this.ctx, time);
  }

  depth(amount: number, time = 0.03) {
    glide(this.out.gain, amount, this.ctx, time);
  }

  dispose() {
    this.osc.stop();
    this.osc.disconnect();
    this.out.disconnect();
  }
}

/** A unity-gain tanh clip: input → ÷HEADROOM → curve. Bounded at ±1. */
export function softClip(ctx: BaseAudioContext) {
  const input = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  input.gain.value = 1 / HEADROOM;
  shaper.curve = tanhCurve(HEADROOM);
  input.connect(shaper);
  return { input, output: shaper };
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** A stereo pair of mono signals → one 2-channel node. */
function merge(ctx: BaseAudioContext, l: AudioNode, r: AudioNode) {
  const m = ctx.createChannelMerger(2);
  l.connect(m, 0, 0);
  r.connect(m, 0, 1);
  return m;
}

/** Sums whatever arrives (mono or stereo) to one channel. */
function mono(ctx: BaseAudioContext) {
  const g = ctx.createGain();
  g.channelCount = 1;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'speakers';
  return g;
}

// ── Modulated delay voices: chorus, ensemble, flanger, vibrato ─────────────────────────────────

export interface VoicesSettings {
  rateHz: number;
  /** LFO swing, seconds either side of the centre delay. */
  depth: number;
  /** Delay before the swing (predelay / flanger "manual"), seconds. */
  pre: number;
  /** Per-voice feedback, -0.99…+0.99 (flangers). */
  fb?: number;
  wave?: Wave;
  /** Extra LFO phase of the right-hand voices, degrees. */
  spread?: number;
  /** Right-hand LFO rate as a multiple of the left (CH/CH). */
  rateR?: number;
  /** Low-pass on the voices, Hz. */
  lpf?: number;
  /** How wide the voices are panned, 0–1. */
  width?: number;
}

/**
 * `n` modulated delay voices per channel (the M7 Stereo Chorus has two, Deca Chorus five: manual
 * pp.23–24), each with its own LFO phase, predelay and pan, optionally with feedback. With
 * `ensemble` a faster, shallow second LFO is added to every voice.
 */
export class Voices implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly lfos: Lfo[] = [];
  private readonly fast: Lfo[] = [];
  private readonly delays: DelayNode[] = [];
  private readonly fbs: GainNode[] = [];
  private readonly tones: BiquadFilterNode[] = [];
  private readonly pans: StereoPannerNode[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly n: number,
    maxPre = 1.3,
    ensemble = false,
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = 1 / Math.sqrt(n);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) {
        const d = ctx.createDelay(maxPre + 0.1);
        const fb = ctx.createGain();
        fb.gain.value = 0;
        const tone = filter(ctx, 'lowpass', 16000);
        const pan = ctx.createStereoPanner();
        const lfo = new Lfo(ctx);
        lfo.out.connect(d.delayTime);
        this.input.connect(d);
        d.connect(fb).connect(d);
        d.connect(tone).connect(pan).connect(this.output);
        if (ensemble) {
          const f = new Lfo(ctx, 0, (i * 137 + c * 90) % 360);
          f.out.connect(d.delayTime);
          this.fast.push(f);
        }
        this.delays.push(d);
        this.fbs.push(fb);
        this.tones.push(tone);
        this.pans.push(pan);
        this.lfos.push(lfo);
      }
    }
  }

  set(s: VoicesSettings) {
    const ctx = this.ctx;
    const n = this.n;
    const depth = Math.max(0, s.depth);
    this.delays.forEach((d, v) => {
      const c = v >= n ? 1 : 0;
      const i = v % n;
      const lfo = this.lfos[v];
      lfo.shape(s.wave ?? 0, (i * 360) / n + c * (s.spread ?? 90));
      lfo.rate(s.rateHz * (c && s.rateR ? s.rateR : 1));
      lfo.depth(depth);
      // Each voice sits a little later than the one before, so they don't comb together.
      glide(d.delayTime, s.pre * (1 + 0.13 * i) + depth + 0.0015 * (i + 1), ctx, 0.05);
      glide(this.fbs[v].gain, clamp(s.fb ?? 0, -0.95, 0.95), ctx);
      glide(this.tones[v].frequency, s.lpf ?? 16000, ctx);
      const side = c ? 1 : -1;
      const spread = n === 1 ? 1 : 0.35 + (0.65 * i) / (n - 1);
      glide(this.pans[v].pan, side * spread * (s.width ?? 0.9), ctx);
      const f = this.fast[v];
      if (f) {
        f.rate(s.rateHz * 6.3);
        f.depth(depth * 0.12);
      }
    });
  }

  dispose() {
    for (const l of [...this.lfos, ...this.fast]) l.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── Stereo feedback delay ─────────────────────────────────────────────────────────────────────

export interface DelaySettings {
  timeL: number;
  timeR: number;
  /** Each channel back into itself, -1…+1 (negative = phase inverse). */
  self: number;
  /** Each channel into the other (ping-pong / the D7 Multi-Delay's cross feedback). */
  cross: number;
  /** How much input reaches each line (ping-pong feeds the left only). */
  inL?: number;
  inR?: number;
  /** Feedback tone: shelving gains in dB, and a low-pass in Hz. */
  bassDb?: number;
  trebleDb?: number;
  lpf?: number;
}

/**
 * Two delay lines with a 2×2 feedback matrix, bass / treble shelves and a low-pass in the loop
 * (the DPS-D7 "feedback bass / treble", p.15; the V55 delay LPF, p.19), and a unity-gain soft clip
 * on the way back so even +12 dB of loop EQ at 100 % feedback stays bounded.
 */
export class StereoDelay implements Block {
  readonly input: GainNode;
  readonly output: AudioNode;
  private readonly ins: GainNode[] = [];
  private readonly lines: DelayNode[] = [];
  private readonly bass: BiquadFilterNode[] = [];
  private readonly treble: BiquadFilterNode[] = [];
  private readonly lpf: BiquadFilterNode[] = [];
  /** [LL, LR, RR, RL]: from → to. */
  private readonly fb: GainNode[] = [];
  private first = true;

  constructor(
    private readonly ctx: BaseAudioContext,
    maxTime = 1.4,
  ) {
    this.input = ctx.createGain();
    const outs: AudioNode[] = [];
    for (let c = 0; c < 2; c++) {
      const inGain = ctx.createGain();
      const line = ctx.createDelay(maxTime + 0.05);
      const bass = filter(ctx, 'lowshelf', 200);
      const treble = filter(ctx, 'highshelf', 4000);
      const lp = filter(ctx, 'lowpass', 16000);
      this.input.connect(inGain).connect(line);
      line.connect(bass).connect(treble).connect(lp);
      this.ins.push(inGain);
      this.lines.push(line);
      this.bass.push(bass);
      this.treble.push(treble);
      this.lpf.push(lp);
      outs.push(lp);
    }
    for (let from = 0; from < 2; from++) {
      const clip = softClip(ctx);
      outs[from].connect(clip.input);
      for (const to of [from, 1 - from]) {
        const g = ctx.createGain();
        g.gain.value = 0;
        clip.output.connect(g).connect(this.lines[to]);
        this.fb.push(g);
      }
    }
    this.output = merge(ctx, outs[0], outs[1]);
  }

  set(s: DelaySettings) {
    const ctx = this.ctx;
    [s.timeL, s.timeR].forEach((t, c) => {
      const v = Math.max(0.0001, t);
      if (this.first) this.lines[c].delayTime.value = v;
      // The DPS delays change time with a short pitch slide rather than a click.
      else glide(this.lines[c].delayTime, v, ctx, 0.08);
      glide(this.ins[c].gain, c ? (s.inR ?? 1) : (s.inL ?? 1), ctx);
      glide(this.bass[c].gain, s.bassDb ?? 0, ctx);
      glide(this.treble[c].gain, s.trebleDb ?? 0, ctx);
      glide(this.lpf[c].frequency, s.lpf ?? 16000, ctx);
    });
    this.first = false;
    const self = clamp(s.self, -1, 1);
    const cross = clamp(s.cross, -1, 1);
    [self, cross, self, cross].forEach((g, i) => glide(this.fb[i].gain, g, ctx));
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── Convolution: tap patterns and reverbs ─────────────────────────────────────────────────────

/**
 * A ConvolverNode whose impulse response can be swapped without a click: the new response loads
 * into a second convolver and the two crossfade. `schedule` debounces rebuilds while a knob turns
 * (building a long impulse takes a few milliseconds of main-thread time).
 */
export class IrConvolver implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly conv: ConvolverNode[] = [];
  private readonly gains: GainNode[] = [];
  private active = 0;
  private key = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    for (let i = 0; i < 2; i++) {
      const c = ctx.createConvolver();
      c.normalize = false;
      const g = ctx.createGain();
      g.gain.value = 0;
      this.input.connect(c).connect(g).connect(this.output);
      this.conv.push(c);
      this.gains.push(g);
    }
  }

  /** Builds `make()` when `key` changes: at once the first time, then after the knob settles. */
  schedule(key: string, make: () => Float32Array<ArrayBuffer>[], wait = 120) {
    if (key === this.key) return;
    const first = this.key === '';
    this.key = key;
    clearTimeout(this.timer);
    if (first) this.load(make());
    else this.timer = setTimeout(() => this.load(make()), wait);
  }

  private load(channels: Float32Array<ArrayBuffer>[]) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(channels.length, channels[0].length, rate);
    channels.forEach((d, i) => buf.copyToChannel(d, i));
    const next = this.conv[this.active].buffer ? 1 - this.active : this.active;
    this.conv[next].buffer = buf;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      this.gains[i].gain.cancelScheduledValues(t);
      this.gains[i].gain.setTargetAtTime(i === next ? 1 : 0, t, 0.04);
    }
    this.active = next;
  }

  dispose() {
    clearTimeout(this.timer);
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** A multi-tap delay as a sparse impulse response (taps with level, phase and pan). */
export class TapDelay extends IrConvolver {
  setTaps(taps: Tap[]) {
    const key = taps
      .map((t) => `${t.time.toFixed(4)}:${t.level.toFixed(3)}:${t.pan.toFixed(2)}`)
      .join(',');
    const rate = this.input.context.sampleRate;
    this.schedule(key, () => tapIR(taps, rate), 60);
  }
}

/**
 * One delay line with tone and feedback, read out through a tap pattern (the DPS-D7 Long Tap and
 * Panpot Tap Delays, pp.18–19):
 *
 *   in → (+) ─┬→ taps (convolver) → out
 *         ↑   └→ line (fbTime) → bass → treble → clip → feedback ┘
 */
export class TapLine implements Block {
  readonly input: GainNode;
  readonly output: AudioNode;
  readonly taps: TapDelay;
  private readonly line: DelayNode;
  private readonly bass: BiquadFilterNode;
  private readonly treble: BiquadFilterNode;
  private readonly fb: GainNode;
  private first = true;

  constructor(
    private readonly ctx: BaseAudioContext,
    maxTime = 2.8,
  ) {
    this.input = mono(ctx);
    const sum = ctx.createGain();
    this.line = ctx.createDelay(maxTime + 0.05);
    this.bass = filter(ctx, 'lowshelf', 200);
    this.treble = filter(ctx, 'highshelf', 4000);
    this.fb = ctx.createGain();
    this.fb.gain.value = 0;
    const clip = softClip(ctx);
    this.taps = new TapDelay(ctx);
    this.input.connect(sum);
    sum.connect(this.taps.input);
    sum.connect(this.line).connect(this.bass).connect(this.treble).connect(clip.input);
    clip.output.connect(this.fb).connect(sum);
    this.output = this.taps.output;
  }

  set(s: { fbTime: number; fb: number; bassDb: number; trebleDb: number; taps: Tap[] }) {
    const t = Math.max(0.0001, s.fbTime);
    if (this.first) this.line.delayTime.value = t;
    else glide(this.line.delayTime, t, this.ctx, 0.08);
    this.first = false;
    glide(this.fb.gain, clamp(s.fb, -1, 1), this.ctx);
    glide(this.bass.gain, s.bassDb, this.ctx);
    glide(this.treble.gain, s.trebleDb, this.ctx);
    this.taps.setTaps(s.taps);
  }

  dispose() {
    this.taps.dispose();
    this.input.disconnect();
  }
}

export interface ReverbSettings {
  rt: number;
  pre: number;
  damp: number;
  size: number;
  early: number;
  seed?: number;
}

/** A convolution reverb from `reverbIR`, rebuilt only when its shape changes. */
export class Reverb extends IrConvolver {
  setShape(s: ReverbSettings) {
    const q = (x: number, step: number) => Math.round(x / step) * step;
    const shape = {
      seconds: q(s.rt, s.rt < 2 ? 0.05 : 0.2),
      preDelay: q(s.pre, 0.002),
      damp: q(s.damp, 0.05),
      size: q(s.size, 0.05),
      early: q(s.early, 0.05),
      seed: s.seed ?? 7,
    };
    const rate = this.input.context.sampleRate;
    this.schedule(JSON.stringify(shape), () => reverbIR(shape, rate), 150);
  }
}

// ── Phaser ────────────────────────────────────────────────────────────────────────────────────

export interface PhaserSettings {
  rateHz: number;
  /** Sweep, 0–1 (= ±2 octaves). */
  depth: number;
  /** Centre of the sweep, 0–1 (≈ 150 Hz … 4 kHz). */
  manual: number;
  /** Feedback round the stages, -0.95…+0.95. */
  resonance: number;
  wave?: Wave;
  spread?: number;
}

/**
 * All-pass stages per channel swept by an LFO on their `detune` (so the sweep is exponential),
 * with resonance fed back through a short DelayNode (M7 Multi Phaser, p.35). The output is the
 * shifted signal only: mixed with the direct sound it makes the moving notches.
 */
export class Phaser implements Block {
  readonly input: GainNode;
  readonly output: AudioNode;
  private readonly stages: BiquadFilterNode[][] = [];
  private readonly lfos: Lfo[] = [];
  private readonly fbs: GainNode[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    count = 8,
  ) {
    this.input = ctx.createGain();
    const outs: AudioNode[] = [];
    for (let c = 0; c < 2; c++) {
      const sum = ctx.createGain();
      this.input.connect(sum);
      const lfo = new Lfo(ctx);
      const chain: BiquadFilterNode[] = [];
      let node: AudioNode = sum;
      for (let i = 0; i < count; i++) {
        const f = filter(ctx, 'allpass', 600, 0.6);
        lfo.out.connect(f.detune);
        node = node.connect(f);
        chain.push(f);
      }
      const fb = ctx.createGain();
      fb.gain.value = 0;
      const loop = ctx.createDelay(0.01);
      loop.delayTime.value = 0;
      node.connect(fb).connect(loop).connect(sum);
      outs.push(node);
      this.stages.push(chain);
      this.lfos.push(lfo);
      this.fbs.push(fb);
    }
    this.output = merge(this.ctx, outs[0], outs[1]);
  }

  set(s: PhaserSettings) {
    const centre = 150 * Math.pow(4000 / 150, clamp(s.manual, 0, 1));
    this.stages.forEach((chain, c) => {
      chain.forEach((f, i) => glide(f.frequency, centre * (1 + 0.08 * i), this.ctx));
      this.lfos[c].shape(s.wave ?? 0, c * (s.spread ?? 90));
      this.lfos[c].rate(s.rateHz);
      this.lfos[c].depth(clamp(s.depth, 0, 1) * 2400);
      glide(this.fbs[c].gain, clamp(s.resonance, -0.95, 0.95), this.ctx);
    });
  }

  dispose() {
    for (const l of this.lfos) l.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── Amplitude and position: tremolo, auto-pan, Haas panner ───────────────────────────────────

/** Gain swung by an LFO per channel, the right channel `phase` degrees later (V55 Tremolo, p.35). */
export class Tremolo implements Block {
  readonly input: GainNode;
  readonly output: AudioNode;
  private readonly gains: GainNode[] = [];
  private readonly lfos: Lfo[] = [];

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    for (let c = 0; c < 2; c++) {
      const g = ctx.createGain();
      const lfo = new Lfo(ctx);
      lfo.out.connect(g.gain);
      this.input.connect(g);
      this.gains.push(g);
      this.lfos.push(lfo);
    }
    this.output = merge(ctx, this.gains[0], this.gains[1]);
  }

  set(s: { rateHz: number; depth: number; wave?: Wave; phase?: number }) {
    const d = clamp(s.depth, 0, 1) / 2;
    this.gains.forEach((g, c) => {
      glide(g.gain, 1 - d, this.ctx);
      this.lfos[c].shape(s.wave ?? 0, c * (s.phase ?? 0));
      this.lfos[c].rate(s.rateHz);
      this.lfos[c].depth(d);
    });
  }

  dispose() {
    for (const l of this.lfos) l.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

/**
 * Auto-panner: the sound moves between `centre ± width` (the D7 "limit min / max", p.21; the M7
 * Stereo Panner, p.42) at the LFO rate.
 */
export class AutoPan implements Block {
  readonly input: GainNode;
  readonly output: StereoPannerNode;
  readonly lfo: Lfo;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = mono(ctx);
    this.output = ctx.createStereoPanner();
    this.lfo = new Lfo(ctx);
    this.lfo.out.connect(this.output.pan);
    this.input.connect(this.output);
  }

  set(s: { rateHz: number; width: number; centre?: number; wave?: Wave }) {
    const w = clamp(s.width, 0, 1);
    const c = clamp(s.centre ?? 0, -1 + w, 1 - w);
    glide(this.output.pan, c, this.ctx);
    this.lfo.shape(s.wave ?? 0, 0);
    this.lfo.rate(s.rateHz);
    this.lfo.depth(w);
  }

  dispose() {
    this.lfo.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

/**
 * Haas panner (V55 p.27): the image moves by delaying one channel against the other by up to
 * about a millisecond, swung by an LFO in opposite directions on each side.
 */
export class HaasPan implements Block {
  readonly input: GainNode;
  readonly output: AudioNode;
  private readonly delays: DelayNode[] = [];
  private readonly lfos: Lfo[] = [];

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = mono(ctx);
    for (let c = 0; c < 2; c++) {
      const d = ctx.createDelay(0.01);
      const lfo = new Lfo(ctx, 0, c * 180);
      lfo.out.connect(d.delayTime);
      this.input.connect(d);
      this.delays.push(d);
      this.lfos.push(lfo);
    }
    this.output = merge(ctx, this.delays[0], this.delays[1]);
  }

  set(s: { rateHz: number; depth: number; wave?: Wave }) {
    const swing = 0.0009 * clamp(s.depth, 0, 1);
    this.delays.forEach((d, c) => {
      glide(d.delayTime, 0.001, this.ctx);
      this.lfos[c].shape(s.wave ?? 0, c * 180);
      this.lfos[c].rate(s.rateHz);
      this.lfos[c].depth(swing);
    });
  }

  dispose() {
    for (const l of this.lfos) l.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── Pitch shifting ────────────────────────────────────────────────────────────────────────────

/**
 * Two delay taps swept by a phase-locked sawtooth, half a cycle apart, each faded by a raised
 * cosine that is silent at the sawtooth's jump (`pitchPlan`). Predelay and feedback as on the V55
 * Stereo Pitch Shifter (p.21); a negative ratio plays each window backwards (Reverse Shifter).
 */
export class PitchShift implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly pre: DelayNode;
  private readonly fb: GainNode;
  private readonly taps: DelayNode[] = [];
  private readonly saws: GainNode[] = [];
  private readonly oscs: OscillatorNode[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    maxPre = 1.2,
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = ctx.createDelay(maxPre + 0.05);
    this.fb = ctx.createGain();
    this.fb.gain.value = 0;
    const sum = ctx.createGain();
    this.input.connect(this.pre).connect(sum);
    const saw = sawHarmonics();
    const win = windowHarmonics();
    for (let i = 0; i < 2; i++) {
      const tap = ctx.createDelay(1.5);
      const sawOsc = ctx.createOscillator();
      sawOsc.setPeriodicWave(periodicWave(ctx, `saw${i}`, () => shiftHarmonics(saw, i * 180)));
      const sawGain = ctx.createGain();
      sawOsc.connect(sawGain).connect(tap.delayTime);
      const winOsc = ctx.createOscillator();
      winOsc.setPeriodicWave(periodicWave(ctx, `win${i}`, () => shiftHarmonics(win, i * 180)));
      const fade = ctx.createGain();
      fade.gain.value = 0.5;
      winOsc.connect(fade.gain);
      sum.connect(tap).connect(fade).connect(this.output);
      sawOsc.start();
      winOsc.start();
      this.taps.push(tap);
      this.saws.push(sawGain);
      this.oscs.push(sawOsc, winOsc);
    }
    const clip = softClip(ctx);
    this.output.connect(clip.input);
    clip.output.connect(this.fb).connect(sum);
  }

  set(s: { ratio: number; window?: number; pre?: number; fb?: number }) {
    const plan = pitchPlan(s.ratio, s.window ?? 0.06);
    for (const o of this.oscs) glide(o.frequency, plan.freq, this.ctx, 0.03);
    this.saws.forEach((g) => glide(g.gain, plan.amp, this.ctx, 0.03));
    this.taps.forEach((t) => glide(t.delayTime, plan.centre, this.ctx, 0.03));
    glide(this.pre.delayTime, Math.max(0, s.pre ?? 0), this.ctx, 0.05);
    glide(this.fb.gain, clamp(s.fb ?? 0, -0.95, 0.95), this.ctx);
  }

  dispose() {
    for (const o of this.oscs) {
      o.stop();
      o.disconnect();
    }
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── Ring modulator with feedback delay (M7 Algorithm 19, p.47) ───────────────────────────────

export class RingMod implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly osc: OscillatorNode;
  private readonly line: DelayNode;
  private readonly fb: GainNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const ring = ctx.createGain();
    ring.gain.value = 0;
    this.osc = ctx.createOscillator();
    this.osc.connect(ring.gain);
    this.osc.start();
    this.line = ctx.createDelay(1.1);
    this.fb = ctx.createGain();
    this.fb.gain.value = 0;
    const clip = softClip(ctx);
    this.input.connect(ring).connect(this.line).connect(this.output);
    this.line.connect(clip.input);
    clip.output.connect(this.fb).connect(this.line);
  }

  set(s: { osc: number; time: number; fb: number }) {
    glide(this.osc.frequency, s.osc, this.ctx);
    glide(this.line.delayTime, Math.max(0, s.time), this.ctx, 0.08);
    glide(this.fb.gain, clamp(s.fb, 0, 0.95), this.ctx);
  }

  dispose() {
    this.osc.stop();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── Rotary speaker (M7 Algorithm 20, p.48; V55 effect 07, p.11) ──────────────────────────────

/** Rotor speeds from the M7 table's ranges: horn / rotor fast and slow, Hz. */
export const ROTARY = { hornSlow: 0.8, hornFast: 6.8, rotorSlow: 0.6, rotorFast: 5.6 };

/**
 * Overdrive → crossover at 800 Hz. The horn (highs) gets Doppler from a swept delay, amplitude
 * modulation and panning; the rotor (lows) amplitude and a gentler pan. Speed changes ramp with
 * the horn's and the rotor's own rise / fall times (the rotor is heavier, so slower).
 */
export class Rotary implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly drive: GainNode;
  private readonly level: GainNode;
  private readonly hornLfo: Lfo[];
  private readonly rotorLfo: Lfo[];
  private readonly hornAm: GainNode;
  private readonly rotorAm: GainNode;
  private fast = -1;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.drive = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(0.15);
    this.level = ctx.createGain();
    this.input.connect(this.drive).connect(shaper).connect(this.level);
    const hp = filter(ctx, 'highpass', 800);
    const lp = filter(ctx, 'lowpass', 800);
    this.level.connect(hp);
    this.level.connect(lp);
    // Horn: Doppler delay, AM, pan; LFO 0 drives position (sin), LFO 1 the cos for Doppler / AM.
    this.hornLfo = [new Lfo(ctx, 0, 0), new Lfo(ctx, 0, 90)];
    this.rotorLfo = [new Lfo(ctx, 0, 0), new Lfo(ctx, 0, 90)];
    const doppler = ctx.createDelay(0.02);
    doppler.delayTime.value = 0.002;
    this.hornLfo[1].out.connect(doppler.delayTime);
    this.hornAm = ctx.createGain();
    const hornPan = ctx.createStereoPanner();
    this.hornLfo[0].out.connect(hornPan.pan);
    hp.connect(doppler).connect(this.hornAm).connect(hornPan).connect(this.output);
    this.rotorAm = ctx.createGain();
    const rotorPan = ctx.createStereoPanner();
    this.rotorLfo[0].out.connect(rotorPan.pan);
    lp.connect(this.rotorAm).connect(rotorPan).connect(this.output);
    // AM rides on the Doppler LFOs through their own gains.
    const hAm = ctx.createGain();
    hAm.gain.value = 0.3;
    this.hornLfo[1].osc.connect(hAm).connect(this.hornAm.gain);
    const rAm = ctx.createGain();
    rAm.gain.value = 0.2;
    this.rotorLfo[1].osc.connect(rAm).connect(this.rotorAm.gain);
  }

  set(s: { fast: boolean; depth: number; drive: number; balance?: number }) {
    const ctx = this.ctx;
    const d = clamp(s.depth, 0, 1);
    const fast = s.fast ? 1 : 0;
    if (fast !== this.fast) {
      const first = this.fast < 0;
      this.fast = fast;
      // Rising (slow → fast) about 1.5 s for the horn and 3 s for the rotor; falling a bit longer.
      const horn = s.fast ? ROTARY.hornFast : ROTARY.hornSlow;
      const rotor = s.fast ? ROTARY.rotorFast : ROTARY.rotorSlow;
      for (const l of this.hornLfo) l.rate(horn, first ? 0.001 : s.fast ? 0.5 : 0.8);
      for (const l of this.rotorLfo) l.rate(rotor, first ? 0.001 : s.fast ? 1.0 : 1.5);
    }
    this.hornLfo[0].depth(0.7 * d);
    this.hornLfo[1].depth(0.0006 * d);
    this.rotorLfo[0].depth(0.35 * d);
    this.rotorLfo[1].depth(0);
    glide(this.hornAm.gain, 0.85, ctx);
    glide(this.rotorAm.gain, 0.9, ctx);
    glide(this.drive.gain, 1 + 6 * clamp(s.drive, 0, 1), ctx);
    glide(this.level.gain, 1 / (1 + 2 * clamp(s.drive, 0, 1)), ctx);
  }

  dispose() {
    for (const l of [...this.hornLfo, ...this.rotorLfo]) l.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

// ── EQ, dynamics, drive, exciter, gate, envelope ─────────────────────────────────────────────

/** Bass shelf → peaking → treble shelf (the DPS-D7 equalizer block, p.14). */
export class Eq3 implements Block {
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    low = 200,
    mid = 1000,
    high = 5000,
  ) {
    this.input = filter(ctx, 'lowshelf', low);
    this.mid = filter(ctx, 'peaking', mid, 0.9);
    this.output = filter(ctx, 'highshelf', high);
    this.input.connect(this.mid).connect(this.output);
  }

  set(s: {
    low: number;
    mid?: number;
    high: number;
    lowHz?: number;
    midHz?: number;
    highHz?: number;
    q?: number;
  }) {
    glide(this.input.gain, s.low, this.ctx);
    glide(this.mid.gain, s.mid ?? 0, this.ctx);
    glide(this.output.gain, s.high, this.ctx);
    if (s.lowHz) glide(this.input.frequency, s.lowHz, this.ctx);
    if (s.midHz) glide(this.mid.frequency, s.midHz, this.ctx);
    if (s.highHz) glide(this.output.frequency, s.highHz, this.ctx);
    if (s.q) glide(this.mid.Q, s.q, this.ctx);
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Compressor / limiter: a DynamicsCompressorNode with make-up gain. */
export class Dynamics implements Block {
  readonly input: DynamicsCompressorNode;
  readonly output: GainNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createDynamicsCompressor();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }

  /** threshold dB, ratio, attack / release s, makeup dB. */
  set(s: {
    threshold: number;
    ratio: number;
    attack: number;
    release: number;
    knee?: number;
    makeup: number;
  }) {
    const c = this.input;
    glide(c.threshold, clamp(s.threshold, -60, 0), this.ctx);
    glide(c.ratio, clamp(s.ratio, 1, 20), this.ctx);
    glide(c.attack, clamp(s.attack, 0.0005, 1), this.ctx);
    glide(c.release, clamp(s.release, 0.01, 1), this.ctx);
    glide(c.knee, s.knee ?? 6, this.ctx);
    glide(this.output.gain, Math.pow(10, s.makeup / 20), this.ctx);
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Gain → soft clip → tone low-pass → level (V55 Driver, p.28; amp simulator). */
export class Drive implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly tone: BiquadFilterNode;
  private readonly body: BiquadFilterNode;
  private amount = -1;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.body = filter(ctx, 'highpass', 80);
    this.tone = filter(ctx, 'lowpass', 5000);
    this.output = ctx.createGain();
    this.input.connect(this.shaper).connect(this.body).connect(this.tone).connect(this.output);
  }

  set(s: { gain: number; level: number; toneHz: number; lowHz?: number }) {
    const g = Math.round(clamp(s.gain, 0, 1) * 50) / 50;
    if (g !== this.amount) {
      this.amount = g;
      this.shaper.curve = driveCurve(g);
    }
    glide(this.tone.frequency, s.toneHz, this.ctx);
    glide(this.body.frequency, s.lowHz ?? 80, this.ctx);
    glide(this.output.gain, s.level, this.ctx);
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Dry plus high-passed, saturated harmonics (V55 Exciter, p.33; M7 pre-effects SXE / DEX). */
export class Exciter implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly hp: BiquadFilterNode;
  private readonly hp2: BiquadFilterNode;
  private readonly amount: GainNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.hp = filter(ctx, 'highpass', 3000);
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(0.4);
    this.hp2 = filter(ctx, 'highpass', 3000);
    this.amount = ctx.createGain();
    this.input.connect(this.output);
    this.input
      .connect(this.hp)
      .connect(shaper)
      .connect(this.hp2)
      .connect(this.amount)
      .connect(this.output);
  }

  set(s: { amount: number; freq: number; level: number }) {
    glide(this.hp.frequency, s.freq, this.ctx);
    glide(this.hp2.frequency, s.freq, this.ctx);
    glide(this.amount.gain, clamp(s.amount, 0, 1) * 0.6, this.ctx);
    glide(this.output.gain, s.level, this.ctx);
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

/**
 * Envelope follower: |x| → one-pole-ish low-pass. Reads about 0.64 × the peak of a steady tone.
 * Drives the gate's key, the auto-wah sweep and the M7's ENV modulation.
 */
export class Envelope {
  readonly input: WaveShaperNode;
  readonly output: BiquadFilterNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createWaveShaper();
    this.input.curve = absCurve();
    this.output = filter(ctx, 'lowpass', 8, 0.5);
    this.input.connect(this.output);
  }

  /** How quickly it follows: roughly the release time in seconds. */
  speed(seconds: number) {
    glide(this.output.frequency, 1 / (2 * Math.PI * clamp(seconds, 0.003, 2)), this.ctx);
  }

  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Noise gate: the envelope keys a smooth step that opens the signal's gain (V55 Gate, p.34). */
export class Gate implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly env: Envelope;
  private readonly key: WaveShaperNode;
  private readonly smooth: BiquadFilterNode;
  private threshold = -1;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.env = new Envelope(ctx);
    this.key = ctx.createWaveShaper();
    this.smooth = filter(ctx, 'lowpass', 30, 0.5);
    this.input.connect(this.env.input);
    this.env.output.connect(this.key).connect(this.smooth).connect(this.output.gain);
    this.input.connect(this.output);
  }

  /** threshold as an envelope reading (0–0.5), release in seconds. */
  set(s: { threshold: number; release: number; hold?: number }) {
    const t = Math.round(clamp(s.threshold, 0.001, 0.6) * 1000) / 1000;
    if (t !== this.threshold) {
      this.threshold = t;
      this.key.curve = gateCurve(t);
    }
    this.env.speed(0.01 + (s.hold ?? 0) * 0.5);
    glide(this.smooth.frequency, 1 / (2 * Math.PI * clamp(s.release, 0.005, 2)), this.ctx);
  }

  dispose() {
    this.env.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Auto-wah: the envelope sweeps a resonant band-pass up (or down, with negative sens). */
export class Wah implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly env: Envelope;
  private readonly sens: GainNode;
  private readonly bp: BiquadFilterNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.env = new Envelope(ctx);
    this.sens = ctx.createGain();
    this.bp = filter(ctx, 'bandpass', 400, 4);
    this.input.connect(this.env.input);
    this.env.output.connect(this.sens).connect(this.bp.detune);
    this.input.connect(this.bp).connect(this.output);
    this.output.gain.value = 2;
  }

  /** sens -1…+1, speed in seconds, base Hz, Q. */
  set(s: { sens: number; speed: number; baseHz: number; q: number }) {
    // A full-scale envelope (~0.6) sweeps about three octaves.
    glide(this.sens.gain, s.sens * 6000, this.ctx);
    this.env.speed(s.speed);
    glide(this.bp.frequency, s.sens >= 0 ? s.baseHz : s.baseHz * 6, this.ctx);
    glide(this.bp.Q, s.q, this.ctx);
  }

  dispose() {
    this.env.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Passes the signal unchanged (an "Effect Off" / Algorithm 0 block). */
export class Through implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = this.input;
  }
  dispose() {
    this.input.disconnect();
  }
}

/**
 * Holds one block at a time and crossfades to a new one when the algorithm changes (the V77
 * "morphing" idea, p.16: the old effect fades while the new one comes in), so switching never
 * clicks. The old block is disconnected once it has faded.
 */
export class Slot<B extends Block> implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private cur?: { key: string; block: B; gain: GainNode };
  /** Blocks fading out, and the timers that will dispose of them. */
  private readonly fading = new Map<ReturnType<typeof setTimeout>, B>();

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
  }

  get block() {
    return this.cur?.block;
  }

  /** Returns the current block, building (and fading to) a new one if `key` changed. */
  use(key: string, make: () => B): B {
    if (this.cur?.key === key) return this.cur.block;
    const t = this.ctx.currentTime;
    const old = this.cur;
    if (old) {
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, 0.025);
      const timer = setTimeout(() => {
        this.fading.delete(timer);
        this.input.disconnect(old.block.input);
        old.gain.disconnect();
        old.block.dispose();
      }, 250);
      this.fading.set(timer, old.block);
    }
    const block = make();
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, t, old ? 0.025 : 0.005);
    this.input.connect(block.input);
    block.output.connect(gain).connect(this.output);
    this.cur = { key, block, gain };
    return block;
  }

  dispose() {
    for (const [timer, block] of this.fading) {
      clearTimeout(timer);
      block.dispose();
    }
    this.cur?.block.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}
