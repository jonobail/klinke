// SH-101 voice, after the service notes' block diagram (p.2):
//
//   KBD / ARP / SEQ (CPU) → portamento → VCO ─┬ saw ──────────────┐
//                                              ├ pulse (PW / PWM) ─┤
//                              SUB OSC (−1 / −2 oct, −2 oct pulse) ┼→ MIXER → VCF (4-pole) → VCA → VOLUME
//                                              NOISE ──────────────┘    ↑ ENV, MOD, KYBD    ↑ ENV or GATE
//   LFO/CLK (triangle / square / random / noise) → VCO MOD, VCF MOD, PWM; it also clocks the
//   arpeggiator, the sequencer, the random source and the envelope's LFO trigger.
//
// The pulse is made the way a comparator makes it: the sawtooth plus a bias, squared up (see
// pwmBias), so its width can be modulated at audio rate. The 4-pole IR3109 filter is two cascaded
// 2-pole low-passes, the second carrying the resonance.

import {
  type Sh101Settings,
  type Step,
  arpeggio,
  comparatorCurve,
  loadStep,
  pwmBias,
  sh101Settings,
  transposeSequence,
} from '../core/sh101';
import { noteFreq } from '../core/sound';
import { MonoKeys, fourier, pulseSamples } from '../core/synth';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

/** How far ahead the clock schedules (s) and how often it wakes up (ms). */
const LOOKAHEAD = 0.1;
const TICK_MS = 25;

export class Sh101Unit extends Unit implements Playable {
  private s!: Sh101Settings;
  private readonly keys = new MonoKeys('last');
  /** Keys held, newest last (for arpeggio and sequence transpose). */
  private held: number[] = [];
  /** HOLD latches the arpeggio chord until a fresh chord is played. */
  private latched: number[] = [];
  private sequence: Step[] = [];
  private seqMode: Sh101Settings['seq'] = 'off';
  private note = 48;
  private gateOn = false;
  private nextTick = 0;
  private step = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  // Sources
  private readonly saw = this.ctx.createOscillator();
  private readonly sub = this.ctx.createOscillator();
  private readonly noise = this.ctx.createBufferSource();
  private readonly pwIn = this.ctx.createGain();
  private readonly pwBias = this.ctx.createConstantSource();
  private readonly comparator = this.ctx.createWaveShaper();
  private readonly dcBlock = this.ctx.createBiquadFilter();
  private readonly pulseLevel = this.ctx.createGain();
  private readonly sawLevel = this.ctx.createGain();
  private readonly subLevel = this.ctx.createGain();
  private readonly noiseLevel = this.ctx.createGain();
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
  private readonly random = this.ctx.createConstantSource();
  private readonly lfo = this.ctx.createOscillator();
  private readonly lfoGate = this.ctx.createGain();
  private readonly randomGate = this.ctx.createGain();
  private readonly noiseModGate = this.ctx.createGain();
  private readonly noiseModFilter = this.ctx.createBiquadFilter();
  private readonly mod = this.ctx.createGain();
  private readonly vcoMod = this.ctx.createGain();
  private readonly vcfMod = this.ctx.createGain();
  private readonly vcfEnv = this.ctx.createGain();
  private readonly kbdTrack = this.ctx.createGain();
  private readonly pwmLfo = this.ctx.createGain();
  private readonly pwmEnv = this.ctx.createGain();
  private readonly vcaEnv = this.ctx.createGain();
  private readonly vcaGate = this.ctx.createGain();
  private readonly bendVco = this.ctx.createGain();
  private readonly bendVcf = this.ctx.createGain();
  /** Bender pushed forward: the LFO into the VCO at the LFO MOD depth. */
  private readonly modPush = this.ctx.createGain();
  private pushed = false;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;

    // VCO: the saw feeds the mixer and the pulse comparator.
    this.saw.type = 'sawtooth';
    this.saw.connect(this.sawLevel).connect(this.mix);
    // Comparator input = (saw + bias + PWM) / 2, so it stays inside the shaper's -1…+1.
    this.pwIn.gain.value = 0.5;
    this.saw.connect(this.pwIn);
    this.pwBias.connect(this.pwIn);
    this.comparator.curve = comparatorCurve();
    this.comparator.oversample = '4x';
    // A pulse narrower or wider than 50 % has a DC offset; the circuit's coupling capacitor
    // blocks it (else a closed filter would still pass it).
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 8;
    this.dcBlock.Q.value = -3.01;
    this.pwIn
      .connect(this.comparator)
      .connect(this.dcBlock)
      .connect(this.pulseLevel)
      .connect(this.mix);
    this.sub.connect(this.subLevel).connect(this.mix);
    this.noise.buffer = this.noiseBuffer();
    this.noise.loop = true;
    this.noise.connect(this.noiseLevel).connect(this.mix);
    this.mix.gain.value = 0.45;

    // VCF → VCA → volume
    this.vcf1.type = this.vcf2.type = 'lowpass';
    this.vcf1.Q.value = -3.01; // Web Audio Q is in dB: no peak on the first stage
    this.mix.connect(this.vcf1).connect(this.vcf2).connect(this.vca).connect(this.volume);
    this.filterCv.connect(this.vcf1.detune);
    this.filterCv.connect(this.vcf2.detune);
    this.vca.gain.value = 0;

    // Modulator: one oscillator (triangle / square), the clocked random level, or slow noise.
    this.lfo.connect(this.lfoGate).connect(this.mod);
    this.random.connect(this.randomGate).connect(this.mod);
    this.noiseModFilter.type = 'lowpass';
    this.noiseModFilter.frequency.value = 40;
    this.noise.connect(this.noiseModFilter).connect(this.noiseModGate).connect(this.mod);
    this.mod.connect(this.vcoMod);
    this.modPush.gain.value = 0;
    this.mod.connect(this.modPush);
    this.mod.connect(this.vcfMod).connect(this.filterCv);
    this.mod.connect(this.pwmLfo).connect(this.pwIn);

    // Pitch modulation into both oscillators
    for (const osc of [this.saw, this.sub]) {
      this.vcoMod.connect(osc.detune);
      this.modPush.connect(osc.detune);
      this.bendVco.connect(osc.detune);
    }
    this.bend.connect(this.bendVco);
    this.bend.connect(this.bendVcf).connect(this.filterCv);

    // Envelope and gate
    for (const c of [this.env, this.gate, this.kbdCv, this.bend, this.random, this.pwBias])
      c.offset.value = 0;
    this.env.connect(this.vcfEnv).connect(this.filterCv);
    this.env.connect(this.pwmEnv).connect(this.pwIn);
    this.env.connect(this.vcaEnv).connect(this.vca.gain);
    this.gate.connect(this.vcaGate).connect(this.vca.gain);
    this.kbdCv.connect(this.kbdTrack).connect(this.filterCv);

    for (const src of this.sources()) src.start();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = sh101Settings(p));
    const ctx = this.ctx;

    for (const osc of [this.saw, this.sub]) glide(osc.detune, s.tuneCents, ctx);
    if (
      !prev ||
      prev.ratio !== s.ratio ||
      prev.transpose !== s.transpose ||
      prev.subMode !== s.subMode
    ) {
      this.setPitch(this.note, ctx.currentTime, 0);
    }
    if (!prev || prev.subMode !== s.subMode) {
      if (s.subMode === 'pulse2') {
        const { real, imag } = fourier(pulseSamples(0.25), 64);
        this.sub.setPeriodicWave(ctx.createPeriodicWave(real, imag));
      } else this.sub.type = 'square';
    }

    // PWM: MAN sets the width; LFO and ENV swing it by the PW slider's amount from 50 %.
    const depth = pwmBias(s.pulseWidth); // 0 at 50 %, toward -1 as the pulse narrows
    glide(this.pwBias.offset, s.pwmSource === 'man' ? depth : 0, ctx);
    glide(this.pwmLfo.gain, s.pwmSource === 'lfo' ? -depth : 0, ctx);
    glide(this.pwmEnv.gain, s.pwmSource === 'env' ? depth : 0, ctx);

    glide(this.pulseLevel.gain, s.pulse, ctx);
    glide(this.sawLevel.gain, s.saw, ctx);
    glide(this.subLevel.gain, s.sub, ctx);
    glide(this.noiseLevel.gain, s.noise, ctx);

    glide(this.vcf1.frequency, s.cutoff, ctx);
    glide(this.vcf2.frequency, s.cutoff, ctx);
    glide(this.vcf2.Q, s.resonance, ctx);
    glide(this.vcfEnv.gain, s.vcfEnv, ctx);
    glide(this.vcfMod.gain, s.vcfMod, ctx);
    glide(this.kbdTrack.gain, s.vcfKybd, ctx);
    glide(this.vcaEnv.gain, s.vcaGate ? 0 : 1, ctx, 0.005);
    glide(this.vcaGate.gain, s.vcaGate ? 1 : 0, ctx, 0.005);

    glide(this.lfo.frequency, s.lfoRate, ctx);
    if (s.lfoWave === 'triangle' || s.lfoWave === 'square') this.lfo.type = s.lfoWave;
    glide(
      this.lfoGate.gain,
      s.lfoWave === 'triangle' || s.lfoWave === 'square' ? 1 : 0,
      ctx,
      0.005,
    );
    glide(this.randomGate.gain, s.lfoWave === 'random' ? 1 : 0, ctx, 0.005);
    glide(this.noiseModGate.gain, s.lfoWave === 'noise' ? 4 : 0, ctx, 0.005);
    glide(this.vcoMod.gain, s.vcoMod, ctx);
    glide(this.bendVco.gain, s.bendVco, ctx);
    glide(this.bendVcf.gain, s.bendVcf, ctx);
    glide(this.modPush.gain, this.pushed ? s.lfoMod : 0, ctx);
    glide(this.volume.gain, s.volume, ctx);

    // LOAD starts a new sequence; leaving ARP / SEQ modes silences what they were playing.
    if (prev && s.seq !== this.seqMode) {
      if (s.seq === 'load') this.saveSequence([]);
      this.gateOff(ctx.currentTime);
    }
    if (prev && prev.arp !== s.arp && s.arp === 'off' && !this.held.length)
      this.gateOff(ctx.currentTime);
    if (prev && prev.hold && !s.hold && !this.held.length) {
      this.latched = [];
      this.gateOff(ctx.currentTime);
    }
    this.seqMode = s.seq;
  }

  /** The stored sequence comes back from the patch (it's kept there, like the battery back-up). */
  override setText(text: Record<string, string>) {
    try {
      const seq = JSON.parse(text['sequence'] ?? '[]');
      if (Array.isArray(seq)) this.sequence = seq.filter((x) => x === null || Number.isFinite(x));
    } catch {
      this.sequence = [];
    }
  }

  private saveSequence(seq: Step[]) {
    this.sequence = seq;
    this.saveText?.('sequence', JSON.stringify(seq));
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number) {
    const t = this.ctx.currentTime;
    const s = this.s;
    if (!this.held.length && s.hold) this.latched = []; // a fresh chord replaces the latched one
    this.held = [...this.held.filter((n) => n !== note), note];
    if (s.hold) this.latched = [...new Set([...this.latched, note])];

    if (s.seq === 'load') this.saveSequence(loadStep(this.sequence, note));
    if (s.seq === 'play' || s.arp !== 'off') return; // the clock plays these
    const { note: sound, trigger } = this.keys.press(note);
    const legato = !trigger;
    this.setPitch(sound, t, this.glideFor(legato));
    if (trigger || s.envTrigger === 'gateTrig') this.gateOnAt(t);
  }

  noteOff(note: number) {
    const t = this.ctx.currentTime;
    this.held = this.held.filter((n) => n !== note);
    const s = this.s;
    if (s.seq === 'play' || s.arp !== 'off') {
      if (!this.held.length && !s.hold) this.gateOff(t);
      return;
    }
    const { note: next, changed } = this.keys.lift(note);
    if (next === null) {
      if (!s.hold) this.gateOff(t);
    } else if (changed) this.setPitch(next, t, this.glideFor(true));
  }

  allNotesOff() {
    this.held = [];
    this.latched = [];
    this.keys.clear();
    this.gateOff(this.ctx.currentTime);
  }

  pitchBend(amount: number) {
    glide(this.bend.offset, amount, this.ctx, 0.01);
  }

  override command(name: string) {
    if (name === 'modOn' || name === 'modOff') {
      this.pushed = name === 'modOn';
      glide(this.modPush.gain, this.pushed ? this.s.lfoMod : 0, this.ctx, 0.03);
      return;
    }
    // REST: a silent step while loading the sequence.
    if (name === 'rest' && this.s.seq === 'load') this.saveSequence(loadStep(this.sequence, null));
  }

  private glideFor(legato: boolean) {
    const s = this.s;
    return s.portamento === 'on' || (s.portamento === 'auto' && legato) ? s.portaTime : 0;
  }

  // ── Clock: arpeggio, sequencer, random, LFO trigger ───

  private schedule() {
    const s = this.s;
    if (!s) return;
    const now = this.ctx.currentTime;
    if (this.nextTick < now) this.nextTick = now + 0.005;
    while (this.nextTick < now + LOOKAHEAD) {
      this.tick(this.nextTick, 1 / s.lfoRate);
      this.nextTick += 1 / s.lfoRate;
    }
  }

  private tick(t: number, period: number) {
    const s = this.s;
    this.random.offset.setValueAtTime(Math.random() * 2 - 1, t);
    const gateLength = period * 0.5;
    if (s.seq === 'play' && this.sequence.length) {
      const line = transposeSequence(this.sequence, this.held.at(-1) ?? null);
      const n = line[this.step++ % line.length];
      if (n !== null) this.playStep(n, t, gateLength);
      return;
    }
    if (s.arp !== 'off') {
      const order = arpeggio(this.held.length ? this.held : s.hold ? this.latched : [], s.arp);
      if (order.length) this.playStep(order[this.step++ % order.length], t, gateLength);
      else this.step = 0;
      return;
    }
    // Envelope trigger from the LFO: retrigger while a key is held.
    if (s.envTrigger === 'lfo' && this.gateOn) this.trigger(t);
  }

  private playStep(note: number, t: number, length: number) {
    this.setPitch(note, t, this.glideFor(false));
    this.gateOnAt(t);
    this.gateOff(t + length);
  }

  // ── Pitch and envelope ────────────────────────────────

  private setPitch(note: number, t: number, glideTime: number) {
    this.note = note;
    const s = this.s;
    const f = noteFreq(note + s.transpose) * s.ratio;
    const subRatio = s.subMode === 'oct1' ? 0.5 : 0.25;
    for (const [param, value] of [
      [this.saw.frequency, f],
      [this.sub.frequency, f * subRatio],
      [this.kbdCv.offset, (note + s.transpose - 60) * 100],
    ] as const) {
      holdAt(param, t);
      if (glideTime > 0) param.setTargetAtTime(value, t, glideTime);
      else param.setValueAtTime(value, t);
    }
  }

  private gateOnAt(t: number) {
    this.gateOn = true;
    holdAt(this.gate.offset, t);
    this.gate.offset.setTargetAtTime(1, t, 0.002);
    this.trigger(t);
  }

  private trigger(t: number) {
    const { attack, decay, sustain } = this.s;
    const o = this.env.offset;
    holdAt(o, t);
    o.linearRampToValueAtTime(1, t + attack);
    o.setTargetAtTime(sustain, t + attack, decay / 4);
  }

  private gateOff(t: number) {
    if (t <= this.ctx.currentTime + 0.001) this.gateOn = false;
    else setTimeout(() => (this.gateOn = false), (t - this.ctx.currentTime) * 1000);
    holdAt(this.gate.offset, t);
    this.gate.offset.setTargetAtTime(0, t, 0.003);
    holdAt(this.env.offset, t);
    this.env.offset.setTargetAtTime(0, t, this.s.release / 4);
  }

  private sources(): AudioScheduledSourceNode[] {
    return [
      this.saw,
      this.sub,
      this.noise,
      this.lfo,
      this.pwBias,
      this.env,
      this.gate,
      this.kbdCv,
      this.bend,
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
