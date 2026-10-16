// JUNO-60 sound, after the service notes' block diagram (p.3):
//
//   KEY ASSIGNER (CH1–CH6) → per voice: DCO ─┬ saw ───────────────┐
//                                            ├ pulse (PW / PWM) ──┤
//                                            ├ sub (−1 oct) ──────┼→ VCF (24 dB) → VCA ─┐
//                         NOISE (one, shared) ┘                   │  ↑ ENV ±, LFO, KYBD  ↑ ENV or GATE
//                                                                                        ▼
//   SUM → HPF (0–3) → VCA LEVEL → CHORUS (2 BBDs, LFO and inverted LFO) → OUT L / R → VOLUME
//
// The six voices are fixed channels built once, as on the hardware. One LFO (triangle, with its
// delay) reaches the DCOs, the VCFs and the PWM through shared control buses; each voice's own
// ADSR drives its VCF, its VCA (ENV mode) and its pulse width (ENV mode).

import { noteFreq } from '../core/sound';
import { comparatorCurve } from '../core/sh101';
import {
  CHORUS,
  CHORUS_LOWPASS,
  CHORUS_WET,
  type Channel,
  HPF_FREQS,
  type Juno60Settings,
  VOICES,
  arpStep,
  arpeggio,
  assignVoice,
  juno60Settings,
  kybdCents,
  onePoleHighpass,
  parseTranspose,
  pwmBias,
} from '../core/juno60';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

/** How far ahead the arpeggio clock schedules (s) and how often it wakes up (ms). */
const LOOKAHEAD = 0.1;
const TICK_MS = 25;

interface Voice {
  saw: OscillatorNode;
  sub: OscillatorNode;
  sawLevel: GainNode;
  pwIn: GainNode;
  pulseLevel: GainNode;
  subLevel: GainNode;
  mix: GainNode;
  vcf1: BiquadFilterNode;
  vcf2: BiquadFilterNode;
  vca: GainNode;
  env: ConstantSourceNode;
  gate: ConstantSourceNode;
  envVcf: GainNode;
  envPwm: GainNode;
  vcaEnv: GainNode;
  vcaGate: GainNode;
  /** The key it plays (before transposition), for its note-off. */
  key: number | null;
  /** When its gate goes off: Infinity while the key is held. */
  offAt: number;
  since: number;
}

export class Juno60Unit extends Unit implements Playable {
  private s!: Juno60Settings;
  private readonly voices: Voice[] = [];
  private last = VOICES - 1;
  private count = 0;
  private bpm = 120;
  /** Keys held, newest last; HOLD latches the arpeggio chord. */
  private held: number[] = [];
  private latched: number[] = [];
  private transpose = 0;
  /** KEY TRANSPOSE pressed: the next key sets the transposition. */
  private arming = false;
  private lfoTrig = false;
  private bend = 0;
  private nextTick = 0;
  private step = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly curve = comparatorCurve();

  // Shared sources and control buses
  private readonly noise = this.ctx.createBufferSource();
  private readonly noiseLevel = this.ctx.createGain();
  private readonly lfo = this.ctx.createOscillator();
  /** The LFO's delay envelope (0…1). */
  private readonly lfoAmount = this.ctx.createGain();
  private readonly dcoLfo = this.ctx.createGain();
  private readonly vcfLfo = this.ctx.createGain();
  private readonly pwmLfo = this.ctx.createGain();
  private readonly pwBias = this.ctx.createConstantSource();
  private readonly pwmCv = this.ctx.createGain();
  /** TUNE + bender into every DCO, bender into every VCF (cents). */
  private readonly pitchCv = this.ctx.createConstantSource();
  private readonly cutoffCv = this.ctx.createConstantSource();
  // Sum, HPF, VCA LEVEL
  private readonly bus = this.ctx.createGain();
  private readonly dcBlock = this.ctx.createBiquadFilter();
  private readonly hpfPaths: GainNode[] = [];
  private readonly level = this.ctx.createGain();
  // Chorus
  private readonly aa1 = this.ctx.createBiquadFilter();
  private readonly aa2 = this.ctx.createBiquadFilter();
  private readonly bbd = [this.ctx.createDelay(0.02), this.ctx.createDelay(0.02)];
  private readonly post = [this.ctx.createBiquadFilter(), this.ctx.createBiquadFilter()];
  private readonly wet = [this.ctx.createGain(), this.ctx.createGain()];
  private readonly chorusLfo = this.ctx.createOscillator();
  private readonly sweep = [this.ctx.createGain(), this.ctx.createGain()];
  private readonly merge = this.ctx.createChannelMerger(2);
  private readonly volume = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;

    // Noise: one generator (TR5, panel board A) into every voice's mixer.
    const rate = ctx.sampleRate;
    const buf = ctx.createBuffer(1, rate * 2, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.noise.connect(this.noiseLevel);

    // LFO (triangle) → delay envelope → DCO, VCF and PWM depths.
    this.lfo.type = 'triangle';
    this.lfo.connect(this.lfoAmount);
    this.lfoAmount.connect(this.dcoLfo);
    this.lfoAmount.connect(this.vcfLfo);
    this.lfoAmount.connect(this.pwmLfo).connect(this.pwmCv);
    this.pwBias.connect(this.pwmCv);
    this.dcoLfo.connect(this.pitchCv.offset);
    this.vcfLfo.connect(this.cutoffCv.offset);
    for (const c of [this.pwBias, this.pitchCv, this.cutoffCv]) c.offset.value = 0;

    for (let i = 0; i < VOICES; i++) this.voices.push(this.voice());

    // Sum → DC block → HPF (flat, or one of three single poles) → VCA LEVEL.
    this.bus.gain.value = 0.32; // six voices at once: headroom
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 5;
    this.dcBlock.Q.value = -3.01;
    this.bus.connect(this.dcBlock);
    for (const f of HPF_FREQS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      if (f) {
        const { feedforward, feedback } = onePoleHighpass(f, ctx.sampleRate);
        this.dcBlock.connect(ctx.createIIRFilter(feedforward, feedback)).connect(g);
      } else this.dcBlock.connect(g);
      g.connect(this.level);
      this.hpfPaths.push(g);
    }

    // Chorus: the direct signal to both sides; the anti-aliased signal through two BBDs swept
    // by the chorus LFO and its inverse, each back into its own side.
    this.level.connect(this.merge, 0, 0);
    this.level.connect(this.merge, 0, 1);
    for (const [f, freq] of [
      [this.aa1, CHORUS_LOWPASS[0]],
      [this.aa2, CHORUS_LOWPASS[1]],
      [this.post[0], CHORUS_LOWPASS[0]],
      [this.post[1], CHORUS_LOWPASS[0]],
    ] as const) {
      f.type = 'lowpass';
      f.frequency.value = freq;
    }
    this.level.connect(this.aa1).connect(this.aa2);
    this.chorusLfo.type = 'triangle';
    for (let side = 0; side < 2; side++) {
      this.aa2.connect(this.bbd[side]).connect(this.post[side]).connect(this.wet[side]);
      this.wet[side].connect(this.merge, 0, side);
      this.wet[side].gain.value = 0;
      this.chorusLfo.connect(this.sweep[side]).connect(this.bbd[side].delayTime);
    }
    this.merge.connect(this.volume);

    for (const src of this.sources()) src.start();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  private voice(): Voice {
    const ctx = this.ctx;
    const v: Voice = {
      saw: ctx.createOscillator(),
      sub: ctx.createOscillator(),
      sawLevel: ctx.createGain(),
      pwIn: ctx.createGain(),
      pulseLevel: ctx.createGain(),
      subLevel: ctx.createGain(),
      mix: ctx.createGain(),
      vcf1: ctx.createBiquadFilter(),
      vcf2: ctx.createBiquadFilter(),
      vca: ctx.createGain(),
      env: ctx.createConstantSource(),
      gate: ctx.createConstantSource(),
      envVcf: ctx.createGain(),
      envPwm: ctx.createGain(),
      vcaEnv: ctx.createGain(),
      vcaGate: ctx.createGain(),
      key: null,
      offAt: 0,
      since: 0,
    };
    v.saw.type = 'sawtooth';
    v.sub.type = 'square';
    v.saw.connect(v.sawLevel).connect(v.mix);
    // Pulse: a comparator on the saw, its threshold set by the PWM bus and the voice's ENV.
    const comparator = ctx.createWaveShaper();
    comparator.curve = this.curve;
    comparator.oversample = '2x';
    v.pwIn.gain.value = 0.5;
    v.saw.connect(v.pwIn);
    this.pwmCv.connect(v.pwIn);
    v.env.connect(v.envPwm).connect(v.pwIn);
    v.pwIn.connect(comparator).connect(v.pulseLevel).connect(v.mix);
    v.sub.connect(v.subLevel).connect(v.mix);
    this.noiseLevel.connect(v.mix);
    v.mix.gain.value = 0.4;
    for (const osc of [v.saw, v.sub]) this.pitchCv.connect(osc.detune);

    // VCF: two 2-pole low-passes (the IR3109's four poles), resonance on the second.
    v.vcf1.type = v.vcf2.type = 'lowpass';
    v.vcf1.Q.value = -3.01;
    for (const f of [v.vcf1, v.vcf2]) {
      this.cutoffCv.connect(f.detune);
      v.envVcf.connect(f.detune);
    }
    v.env.connect(v.envVcf);
    v.mix.connect(v.vcf1).connect(v.vcf2).connect(v.vca).connect(this.bus);
    v.vca.gain.value = 0;
    v.env.connect(v.vcaEnv).connect(v.vca.gain);
    v.gate.connect(v.vcaGate).connect(v.vca.gain);
    v.env.offset.value = 0;
    v.gate.offset.value = 0;
    return v;
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = juno60Settings(p));
    const ctx = this.ctx;

    // PWM: MAN sets the width; LFO and ENV swing it from 50 % by the slider's amount.
    const depth = pwmBias(s.pulseWidth); // 0 at 50 %, −0.9 at 95 %
    glide(
      this.pwBias.offset,
      s.pwmMode === 'man' ? depth : s.pwmMode === 'lfo' ? depth / 2 : 0,
      ctx,
    );
    glide(this.pwmLfo.gain, s.pwmMode === 'lfo' ? depth / 2 : 0, ctx);
    glide(this.noiseLevel.gain, s.noise * 0.6, ctx);
    glide(this.lfo.frequency, s.lfoRate, ctx);
    glide(this.dcoLfo.gain, s.dcoLfo, ctx);
    glide(this.vcfLfo.gain, s.vcfLfo, ctx);
    for (const v of this.voices) {
      glide(v.sawLevel.gain, s.saw ? 1 : 0, ctx, 0.005);
      glide(v.pulseLevel.gain, s.pulse ? 1 : 0, ctx, 0.005);
      glide(v.subLevel.gain, s.subOn ? s.sub : 0, ctx, 0.005);
      glide(v.envPwm.gain, s.pwmMode === 'env' ? depth : 0, ctx);
      glide(v.vcf1.frequency, s.cutoff, ctx);
      glide(v.vcf2.frequency, s.cutoff, ctx);
      glide(v.vcf2.Q, s.resonance, ctx);
      glide(v.envVcf.gain, s.vcfEnv, ctx);
      glide(v.vcaEnv.gain, s.vcaGate ? 0 : 1, ctx, 0.005);
      glide(v.vcaGate.gain, s.vcaGate ? 1 : 0, ctx, 0.005);
    }
    this.hpfPaths.forEach((g, i) => glide(g.gain, HPF_FREQS[i] === s.hpf ? 1 : 0, ctx, 0.01));
    glide(this.level.gain, s.vcaLevel, ctx);
    this.setChorus(s);
    glide(this.volume.gain, s.volume, ctx);
    this.setPitchCv();

    // LFO trigger mode: AUTO runs (its delay restarts with the first key), MAN waits for TRIG.
    if (!prev || prev.lfoManual !== s.lfoManual) {
      glide(this.lfoAmount.gain, s.lfoManual && !this.lfoTrig ? 0 : 1, ctx, 0.01);
    }
    // Octave transpose or key follow changed: retune what's held.
    if (prev && (prev.octave !== s.octave || prev.vcfKybd !== s.vcfKybd)) this.retune();
    const now = ctx.currentTime;
    // HOLD off lets go of keys no longer down; ARPEGGIO on / off hands the held keys over.
    if (prev?.hold && !s.hold) {
      this.latched = [];
      for (const v of this.voices)
        if (v.offAt === Infinity && !this.held.includes(v.key!)) this.gateOff(v, now);
    }
    if (prev && prev.arp !== s.arp) {
      for (const v of this.voices) if (v.offAt === Infinity) this.gateOff(v, now);
      if (!s.arp) for (const k of this.held) this.voiceOn(k, now);
      this.step = 0;
    }
  }

  private setChorus(s: Juno60Settings) {
    const ctx = this.ctx;
    const c = s.chorus === 'off' ? null : CHORUS[s.chorus];
    const mid = c ? (c.min + c.max) / 2 : 0.003;
    const swing = c ? (c.max - c.min) / 2 : 0;
    glide(this.chorusLfo.frequency, c?.rate ?? 0.5, ctx);
    this.bbd.forEach((d, i) => {
      glide(d.delayTime, mid, ctx, 0.05);
      glide(this.sweep[i].gain, i ? -swing : swing, ctx, 0.05);
      glide(this.wet[i].gain, c ? CHORUS_WET : 0, ctx, 0.02);
    });
  }

  override setTempo(bpm: number) {
    if (bpm > 0) this.bpm = bpm;
  }

  /** The KEY TRANSPOSE amount is kept in the patch. */
  override setText(text: Record<string, string>) {
    const t = parseTranspose(text['transpose']);
    if (t !== this.transpose) {
      this.transpose = t;
      if (this.s) this.retune();
    }
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number) {
    const s = this.s;
    const t = this.ctx.currentTime;
    if (this.arming) {
      // KEY TRANSPOSE: the key pressed sets the transposition, C4 being none.
      this.arming = false;
      this.transpose = parseTranspose(String(note - 60));
      this.saveText?.('transpose', String(this.transpose));
      this.retune();
      return;
    }
    const first = !this.held.length;
    this.held = [...this.held.filter((n) => n !== note), note];
    // LFO delay (AUTO): restarts with the first key after all were let go.
    if (first && !s.lfoManual) this.lfoDelay(t);
    if (s.arp) {
      if (first && s.hold) this.latched = [];
      if (s.hold) this.latched = [...new Set([...this.latched, note])];
      return; // the clock plays these
    }
    this.voiceOn(note, t);
  }

  noteOff(note: number) {
    this.held = this.held.filter((n) => n !== note);
    if (this.s.arp || this.s.hold) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) if (v.key === note && v.offAt === Infinity) this.gateOff(v, t);
  }

  allNotesOff() {
    const t = this.ctx.currentTime;
    this.held = [];
    this.latched = [];
    for (const v of this.voices) if (v.offAt > t) this.gateOff(v, t);
  }

  pitchBend(amount: number) {
    this.bend = amount;
    this.setPitchCv(0.01);
  }

  override command(name: string) {
    const t = this.ctx.currentTime;
    if (name === 'keyTranspose') {
      // Lit: press to clear. Unlit: arm, and the next key sets it.
      if (this.transpose) {
        this.transpose = 0;
        this.arming = false;
        this.saveText?.('transpose', '0');
        this.retune();
      } else this.arming = !this.arming;
    } else if (name === 'lfoOn' || name === 'lfoOff') {
      // The bender panel's LFO TRIG button: in MAN mode the LFO comes in (after its delay)
      // while it's held.
      this.lfoTrig = name === 'lfoOn';
      if (!this.s.lfoManual) return;
      if (this.lfoTrig) this.lfoDelay(t);
      else {
        holdAt(this.lfoAmount.gain, t);
        this.lfoAmount.gain.setTargetAtTime(0, t, 0.02);
      }
    }
  }

  private lfoDelay(t: number) {
    const g = this.lfoAmount.gain;
    const d = this.s.lfoDelay;
    holdAt(g, t);
    if (d < 0.01) {
      g.setTargetAtTime(1, t, 0.005);
      return;
    }
    // Silent for the delay time, then fading in over half as long again (fig. 31).
    g.setTargetAtTime(0, t, 0.005);
    g.setValueAtTime(0, t + d);
    g.linearRampToValueAtTime(1, t + d * 1.5);
  }

  private setPitchCv(time = 0.02) {
    const s = this.s;
    if (!s) return;
    glide(this.pitchCv.offset, s.tuneCents + this.bend * s.bendDco, this.ctx, time);
    glide(this.cutoffCv.offset, this.bend * s.bendVcf, this.ctx, time);
  }

  // ── Voices ────────────────────────────────────────────

  private channels(t: number): Channel[] {
    return this.voices.map((v) => ({ key: v.key, down: v.offAt > t, since: v.since }));
  }

  /** Gives a key a channel (p.14) and starts its gate at `t`, ending at `offAt` if known. */
  private voiceOn(key: number, t: number, offAt = Infinity) {
    const i = assignVoice(this.channels(t), this.last, key);
    this.last = i;
    const v = this.voices[i];
    v.key = key;
    v.since = ++this.count;
    v.offAt = offAt;
    this.tune(v, t);
    const s = this.s;
    holdAt(v.gate.offset, t);
    v.gate.offset.setTargetAtTime(1, t, 0.002);
    // ADSR: attack from wherever it is, then decay to sustain.
    const o = v.env.offset;
    holdAt(o, t);
    o.linearRampToValueAtTime(1, t + s.attack);
    o.setTargetAtTime(s.sustain, t + s.attack, s.decay / 4);
    if (offAt !== Infinity) this.gateOff(v, offAt);
  }

  private gateOff(v: Voice, t: number) {
    v.offAt = t;
    holdAt(v.gate.offset, t);
    v.gate.offset.setTargetAtTime(0, t, 0.003);
    holdAt(v.env.offset, t);
    v.env.offset.setTargetAtTime(0, t, this.s.release / 4);
  }

  private tune(v: Voice, t: number) {
    if (v.key === null) return;
    const s = this.s;
    const note = v.key + s.octave + this.transpose;
    const f = noteFreq(note);
    v.saw.frequency.setValueAtTime(f, t);
    v.sub.frequency.setValueAtTime(f / 2, t);
    const k = kybdCents(note, s.vcfKybd);
    v.vcf1.detune.setValueAtTime(k, t);
    v.vcf2.detune.setValueAtTime(k, t);
  }

  private retune() {
    const t = this.ctx.currentTime;
    for (const v of this.voices) this.tune(v, t);
  }

  // ── Arpeggio clock ────────────────────────────────────

  private schedule() {
    const s = this.s;
    if (!s?.arp) return;
    const now = this.ctx.currentTime;
    if (this.nextTick < now) this.nextTick = now + 0.005;
    while (this.nextTick < now + LOOKAHEAD) {
      const period = arpStep(s, this.bpm);
      const order = arpeggio(
        this.held.length ? this.held : s.hold ? this.latched : [],
        s.arpMode,
        s.arpRange,
      );
      if (order.length)
        this.voiceOn(order[this.step++ % order.length], this.nextTick, this.nextTick + period / 2);
      else this.step = 0;
      this.nextTick += period;
    }
  }

  /** For the panel: KEY TRANSPOSE waiting for its key. */
  override status(): string | null {
    return this.arming ? 'arm' : '';
  }

  private sources(): AudioScheduledSourceNode[] {
    return [
      this.noise,
      this.lfo,
      this.pwBias,
      this.pitchCv,
      this.cutoffCv,
      this.chorusLfo,
      ...this.voices.flatMap((v) => [v.saw, v.sub, v.env, v.gate]),
    ];
  }

  override dispose() {
    clearInterval(this.timer);
    for (const src of this.sources()) src.stop();
    super.dispose();
  }
}
