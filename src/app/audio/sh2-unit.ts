// SH-2 voice, after the service notes' block diagram (p.2):
//
//   KEYBOARD (low-note priority) → KCV S/H (PORTAMENTO) ─┬→ VCO-1 ─┬ ∿ / saw / square / pulse (PW, PWM) ─┐
//                                                        │         └ SUB (÷2 square) ───────────────────┤
//                                                        └→ VCO-2 (TUNE WIDE / NARROW) noise / saw /    ┼→ VCF (4-pole) → VCA → VOLUME
//                                                                    square / narrow pulse ─────────────┤    ↑ ENV ± or ENV FOL'R,
//                                                                       AUDIO IN (EXT SIG AMP) ─────────┘      MOD, KYBD, BENDER
//   LFO (∿ / square / RANDOM = noise S/H) → DELAY → VCO MOD, VCF MOD, PWM; it can also gate the ENV.
//   AUTO BEND swoops both VCOs into each new note; the BENDER moves VCO-2 always, VCO-1 when its
//   BENDER switch is on, and the VCF.
//
// The pulses are made as a comparator makes them (saw + bias, squared up; see core/sh101), so the
// PWM can move at audio rate. The 4-pole OTA filter (IC4–IC7, p.7) is two cascaded 2-pole
// low-passes, the second carrying the resonance.

import { comparatorCurve, pwmBias } from '../core/sh101';
import {
  AUTO_BEND_CENTS,
  VCO2_PULSE,
  type Sh2Settings,
  envTriggers,
  roundedTriangle,
  sh2Settings,
} from '../core/sh2';
import { noteFreq } from '../core/sound';
import { MonoKeys, fourier } from '../core/synth';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

/** How far ahead the LFO clock schedules (s) and how often it wakes up (ms). */
const LOOKAHEAD = 0.1;
const TICK_MS = 25;

export class Sh2Unit extends Unit implements Playable {
  private s!: Sh2Settings;
  private readonly keys = new MonoKeys('low');
  private held = 0;
  /** The note the KCV sample-and-hold is sitting on. */
  private note = 48;
  private nextTick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  // VCO-1 and its sub
  private readonly saw1 = this.ctx.createOscillator();
  private readonly sine1 = this.ctx.createOscillator();
  private readonly sub = this.ctx.createOscillator();
  private readonly pw1In = this.ctx.createGain();
  private readonly pw1Bias = this.ctx.createConstantSource();
  private readonly comp1 = this.ctx.createWaveShaper();
  private readonly dc1 = this.ctx.createBiquadFilter();
  private readonly sine1Gate = this.ctx.createGain();
  private readonly saw1Gate = this.ctx.createGain();
  private readonly pulse1Gate = this.ctx.createGain();
  // VCO-2
  private readonly saw2 = this.ctx.createOscillator();
  private readonly noise = this.ctx.createBufferSource();
  private readonly pw2In = this.ctx.createGain();
  private readonly pw2Bias = this.ctx.createConstantSource();
  private readonly comp2 = this.ctx.createWaveShaper();
  private readonly dc2 = this.ctx.createBiquadFilter();
  private readonly noise2Gate = this.ctx.createGain();
  private readonly saw2Gate = this.ctx.createGain();
  private readonly pulse2Gate = this.ctx.createGain();
  // Source mixer, AUDIO IN
  private readonly subLevel = this.ctx.createGain();
  private readonly vco1Level = this.ctx.createGain();
  private readonly vco2Level = this.ctx.createGain();
  private readonly ext = this.ctx.createGain();
  private readonly mix = this.ctx.createGain();
  // Filter, amp
  private readonly vcf1 = this.ctx.createBiquadFilter();
  private readonly vcf2 = this.ctx.createBiquadFilter();
  private readonly filterCv = this.ctx.createGain();
  private readonly vca = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();
  // Control voltages
  private readonly env = this.ctx.createConstantSource();
  private readonly gate = this.ctx.createConstantSource();
  private readonly kbdCv = this.ctx.createConstantSource();
  private readonly bend = this.ctx.createConstantSource();
  private readonly autoBendCv = this.ctx.createConstantSource();
  private readonly random = this.ctx.createConstantSource();
  private readonly lfo = this.ctx.createOscillator();
  private readonly lfoGate = this.ctx.createGain();
  private readonly randomGate = this.ctx.createGain();
  /** The LFO DELAY: fades the modulation in after each trigger. */
  private readonly lfoDelay = this.ctx.createGain();
  private readonly vcoMod = this.ctx.createGain();
  private readonly vcfMod = this.ctx.createGain();
  private readonly pwmLfo = this.ctx.createGain();
  private readonly pwmEnv = this.ctx.createGain();
  /** S3: the ADSR (±) or the AUDIO IN envelope follower, into the VCF ENV slider. */
  private readonly envPolarity = this.ctx.createGain();
  private readonly rectifier = this.ctx.createWaveShaper();
  private readonly followerSmooth = this.ctx.createBiquadFilter();
  private readonly followerGate = this.ctx.createGain();
  private readonly vcfEnv = this.ctx.createGain();
  private readonly kbdTrack = this.ctx.createGain();
  private readonly vcaEnv = this.ctx.createGain();
  private readonly vcaGate = this.ctx.createGain();
  private readonly bendVco1 = this.ctx.createGain();
  private readonly bendVco2 = this.ctx.createGain();
  private readonly bendVcf = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.ext;
    this.output = this.volume;

    // VCO-1: the ∿ wave, the saw, and the comparator pulse (square at 50 %, or PW / PWM).
    const tri = fourier(roundedTriangle(), 48);
    this.sine1.setPeriodicWave(ctx.createPeriodicWave(tri.real, tri.imag));
    this.saw1.type = this.saw2.type = 'sawtooth';
    this.sub.type = 'square'; // the DN819 divider after VCO-1: one octave down (p.4)
    this.sine1.connect(this.sine1Gate).connect(this.vco1Level);
    this.saw1.connect(this.saw1Gate).connect(this.vco1Level);
    this.pulseFrom(this.saw1, this.pw1In, this.pw1Bias, this.comp1, this.dc1);
    this.dc1.connect(this.pulse1Gate).connect(this.vco1Level);
    this.sub.connect(this.subLevel);

    // VCO-2: noise, saw, square or the narrow pulse.
    this.noise.buffer = this.noiseBuffer();
    this.noise.loop = true;
    this.noise.connect(this.noise2Gate).connect(this.vco2Level);
    this.saw2.connect(this.saw2Gate).connect(this.vco2Level);
    this.pulseFrom(this.saw2, this.pw2In, this.pw2Bias, this.comp2, this.dc2);
    this.dc2.connect(this.pulse2Gate).connect(this.vco2Level);

    // SOURCE MIXER (+ the EXT SIG AMP straight into the VCF) → VCF → VCA → VOLUME
    for (const g of [this.subLevel, this.vco1Level, this.vco2Level, this.ext]) g.connect(this.mix);
    this.ext.gain.value = 2;
    this.mix.gain.value = 0.4;
    this.vcf1.type = this.vcf2.type = 'lowpass';
    this.vcf1.Q.value = -3.01; // Web Audio Q is in dB: no peak on the first stage
    this.mix.connect(this.vcf1).connect(this.vcf2).connect(this.vca).connect(this.volume);
    this.filterCv.connect(this.vcf1.detune);
    this.filterCv.connect(this.vcf2.detune);
    this.vca.gain.value = 0;

    // ENV FOL'R: the AUDIO IN rectified and smoothed, scaled to about the ADSR's 0…1.
    this.rectifier.curve = Float32Array.from({ length: 1025 }, (_, i) => Math.abs(i / 512 - 1));
    this.followerSmooth.type = 'lowpass';
    this.followerSmooth.frequency.value = 12;
    this.ext.connect(this.rectifier).connect(this.followerSmooth).connect(this.followerGate);
    this.followerGate.connect(this.vcfEnv);
    this.env.connect(this.envPolarity).connect(this.vcfEnv).connect(this.filterCv);

    // Modulator: the oscillator (∿ / square) or the noise sampled and held, then the DELAY.
    this.lfo.connect(this.lfoGate).connect(this.lfoDelay);
    this.random.connect(this.randomGate).connect(this.lfoDelay);
    this.lfoDelay.connect(this.vcoMod);
    this.lfoDelay.connect(this.vcfMod).connect(this.filterCv);
    this.lfoDelay.connect(this.pwmLfo).connect(this.pw1In);
    this.env.connect(this.pwmEnv).connect(this.pw1In);

    // Pitch: MOD and AUTO BEND into every oscillator; the bender into VCO-2 always, into VCO-1
    // (and its sub) through the BENDER switch.
    for (const osc of [this.saw1, this.sine1, this.sub, this.saw2]) {
      this.vcoMod.connect(osc.detune);
      this.autoBendCv.connect(osc.detune);
    }
    for (const osc of [this.saw1, this.sine1, this.sub]) this.bendVco1.connect(osc.detune);
    this.bendVco2.connect(this.saw2.detune);
    this.bend.connect(this.bendVco1);
    this.bend.connect(this.bendVco2);
    this.bend.connect(this.bendVcf).connect(this.filterCv);

    // ADSR, gate, key follow
    for (const c of [
      this.env,
      this.gate,
      this.kbdCv,
      this.bend,
      this.autoBendCv,
      this.random,
      this.pw1Bias,
      this.pw2Bias,
    ])
      c.offset.value = 0;
    this.env.connect(this.vcaEnv).connect(this.vca.gain);
    this.gate.connect(this.vcaGate).connect(this.vca.gain);
    this.kbdCv.connect(this.kbdTrack).connect(this.filterCv);

    for (const src of this.sources()) src.start();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  /** A comparator pulse from a saw: (saw + bias) / 2, squared up, with its DC blocked. */
  private pulseFrom(
    saw: OscillatorNode,
    sum: GainNode,
    bias: ConstantSourceNode,
    comp: WaveShaperNode,
    dc: BiquadFilterNode,
  ) {
    sum.gain.value = 0.5;
    saw.connect(sum);
    bias.connect(sum);
    comp.curve = comparatorCurve();
    comp.oversample = '4x';
    dc.type = 'highpass';
    dc.frequency.value = 8;
    dc.Q.value = -3.01;
    sum.connect(comp).connect(dc);
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = sh2Settings(p));
    const ctx = this.ctx;

    for (const osc of [this.saw1, this.sine1, this.sub]) glide(osc.detune, s.tuneCents, ctx);
    glide(this.saw2.detune, s.tuneCents + s.tune2Cents, ctx);
    if (!prev || prev.ratio1 !== s.ratio1 || prev.ratio2 !== s.ratio2)
      this.setPitch(this.note, ctx.currentTime, 0);

    // VCO-1 waveform; PWM: MAN sets the width, LFO and ENV swing it by the PW slider's amount.
    const w1 = s.wave1;
    glide(this.sine1Gate.gain, w1 === 'sine' ? 1 : 0, ctx, 0.005);
    glide(this.saw1Gate.gain, w1 === 'saw' ? 1 : 0, ctx, 0.005);
    glide(this.pulse1Gate.gain, w1 === 'square' || w1 === 'pulse' ? 1 : 0, ctx, 0.005);
    const depth = w1 === 'pulse' ? pwmBias(s.pulseWidth) : 0;
    glide(this.pw1Bias.offset, s.pwmSource === 'man' ? depth : 0, ctx);
    glide(this.pwmLfo.gain, s.pwmSource === 'lfo' ? -depth : 0, ctx);
    glide(this.pwmEnv.gain, s.pwmSource === 'env' ? depth : 0, ctx);

    // VCO-2 waveform
    const w2 = s.wave2;
    glide(this.noise2Gate.gain, w2 === 'noise' ? 0.6 : 0, ctx, 0.005);
    glide(this.saw2Gate.gain, w2 === 'saw' ? 1 : 0, ctx, 0.005);
    glide(this.pulse2Gate.gain, w2 === 'square' || w2 === 'pulse' ? 1 : 0, ctx, 0.005);
    glide(this.pw2Bias.offset, w2 === 'pulse' ? pwmBias(VCO2_PULSE) : 0, ctx);

    glide(this.subLevel.gain, s.sub, ctx);
    glide(this.vco1Level.gain, s.vco1, ctx);
    glide(this.vco2Level.gain, s.vco2, ctx);

    glide(this.vcf1.frequency, s.cutoff, ctx);
    glide(this.vcf2.frequency, s.cutoff, ctx);
    glide(this.vcf2.Q, s.resonance, ctx);
    const src = s.vcfEnvSource;
    glide(this.envPolarity.gain, src === 'env' ? 1 : src === 'inverted' ? -1 : 0, ctx, 0.005);
    glide(this.followerGate.gain, src === 'follower' ? 3 : 0, ctx, 0.005);
    glide(this.vcfEnv.gain, s.vcfEnv, ctx);
    glide(this.vcfMod.gain, s.vcfMod, ctx);
    glide(this.kbdTrack.gain, s.vcfKybd, ctx);

    // VCA: HOLD keeps it open (a drone), ENV follows the ADSR, GATE the keys.
    glide(this.vca.gain, s.vcaMode === 'hold' ? 1 : 0, ctx, 0.005);
    glide(this.vcaEnv.gain, s.vcaMode === 'env' ? 1 : 0, ctx, 0.005);
    glide(this.vcaGate.gain, s.vcaMode === 'gate' ? 1 : 0, ctx, 0.005);

    glide(this.lfo.frequency, s.lfoRate, ctx);
    if (s.lfoWave !== 'random') this.lfo.type = s.lfoWave;
    glide(this.lfoGate.gain, s.lfoWave === 'random' ? 0 : 1, ctx, 0.005);
    glide(this.randomGate.gain, s.lfoWave === 'random' ? 1 : 0, ctx, 0.005);
    // With no delay the modulation is always on; with one it waits for the next key.
    if (!prev || prev.lfoDelay > 0 !== s.lfoDelay > 0)
      glide(this.lfoDelay.gain, s.lfoDelay > 0 && !this.held ? 0 : 1, ctx);
    glide(this.vcoMod.gain, s.vcoMod, ctx);

    glide(this.bendVco1.gain, s.bendVco1 ? s.bendVco : 0, ctx);
    glide(this.bendVco2.gain, s.bendVco, ctx);
    glide(this.bendVcf.gain, s.bendVcf, ctx);
    glide(this.volume.gain, s.volume, ctx);
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number) {
    const t = this.ctx.currentTime;
    const fromSilence = this.held === 0;
    this.held++;
    const { note: sound } = this.keys.press(note);
    const changed = sound !== this.note;
    if (changed || fromSilence) this.setPitch(sound, t, this.s.portaTime);
    if (fromSilence) this.gateOnAt(t);
    if (envTriggers(this.s.envTrigger, fromSilence, changed)) this.trigger(t);
    else if (fromSilence) this.startDelay(t); // LFO-gated: the delay still starts with the key
  }

  noteOff(note: number) {
    const t = this.ctx.currentTime;
    this.held = Math.max(0, this.held - 1);
    const { note: next, changed } = this.keys.lift(note);
    if (next === null) {
      this.held = 0;
      this.gateOff(t);
    } else if (changed) {
      this.setPitch(next, t, this.s.portaTime);
      if (envTriggers(this.s.envTrigger, false, true)) this.trigger(t);
    }
  }

  allNotesOff() {
    this.held = 0;
    this.keys.clear();
    this.gateOff(this.ctx.currentTime);
  }

  pitchBend(amount: number) {
    glide(this.bend.offset, amount, this.ctx, 0.01);
  }

  // ── LFO clock: RANDOM sample-and-hold, LFO-gated envelope ──

  private schedule() {
    const s = this.s;
    if (!s) return;
    const now = this.ctx.currentTime;
    if (this.nextTick < now) this.nextTick = now + 0.005;
    while (this.nextTick < now + LOOKAHEAD) {
      const period = 1 / s.lfoRate;
      this.random.offset.setValueAtTime(Math.random() * 2 - 1, this.nextTick);
      // GATE SELECTOR at LFO: the modulator's square gates the ADSR while a key is held.
      if (s.envTrigger === 'lfo' && this.held) {
        this.envOn(this.nextTick);
        this.envOff(this.nextTick + period / 2);
      }
      this.nextTick += period;
    }
  }

  // ── Pitch and envelope ────────────────────────────────

  private setPitch(note: number, t: number, glideTime: number) {
    this.note = note;
    const s = this.s;
    const f = noteFreq(note);
    for (const [param, value] of [
      [this.saw1.frequency, f * s.ratio1],
      [this.sine1.frequency, f * s.ratio1],
      [this.sub.frequency, (f * s.ratio1) / 2],
      [this.saw2.frequency, f * s.ratio2],
      [this.kbdCv.offset, (note - 60) * 100],
    ] as const) {
      holdAt(param, t);
      if (glideTime > 0) param.setTargetAtTime(value, t, glideTime);
      else param.setValueAtTime(value, t);
    }
  }

  private gateOnAt(t: number) {
    holdAt(this.gate.offset, t);
    this.gate.offset.setTargetAtTime(1, t, 0.002);
  }

  /** A trigger: the ADSR restarts, AUTO BEND swoops in and the LFO DELAY starts again. */
  private trigger(t: number) {
    this.envOn(t);
    this.startDelay(t);
    const tau = this.s.autoBend;
    if (tau > 0) {
      const o = this.autoBendCv.offset;
      holdAt(o, t);
      o.setValueAtTime(AUTO_BEND_CENTS, t);
      o.setTargetAtTime(0, t, tau);
    }
  }

  private startDelay(t: number) {
    const d = this.s.lfoDelay;
    if (d <= 0) return;
    const g = this.lfoDelay.gain;
    holdAt(g, t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + d);
  }

  private envOn(t: number) {
    const { attack, decay, sustain } = this.s;
    const o = this.env.offset;
    holdAt(o, t);
    o.linearRampToValueAtTime(1, t + attack);
    o.setTargetAtTime(sustain, t + attack, decay / 4);
  }

  private envOff(t: number) {
    holdAt(this.env.offset, t);
    this.env.offset.setTargetAtTime(0, t, this.s.release / 4);
  }

  private gateOff(t: number) {
    holdAt(this.gate.offset, t);
    this.gate.offset.setTargetAtTime(0, t, 0.003);
    this.envOff(t);
  }

  private sources(): AudioScheduledSourceNode[] {
    return [
      this.saw1,
      this.sine1,
      this.sub,
      this.saw2,
      this.noise,
      this.lfo,
      this.pw1Bias,
      this.pw2Bias,
      this.env,
      this.gate,
      this.kbdCv,
      this.bend,
      this.autoBendCv,
      this.random,
    ];
  }

  private noiseBuffer() {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * 2, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  override dispose() {
    clearInterval(this.timer);
    for (const src of this.sources()) src.stop();
    super.dispose();
  }
}
