// PS-3100 sound, after the panel's signal-flow graphic and the board connector list:
//
//   divide-down oscillators ─ per key: WAVE → dynamic LP filter → VCA, both shaped by that key's
//   own envelope (KLM-69: Attack, Decay, Sustain, Release, Hold per channel) ─┐
//                                                                            ▼
//   RESONATORS (high-pass → 3 band-passes, intensity = dry ↔ peaks) ─┬─ DIRECT OUT
//                                                                    ▼
//   AMPLITUDE MODULATOR (MG2) → ENSEMBLE → VCA 1 → VCA 2 (general envelope) → FINAL OUT / PHONES
//
// Every key has its own voice, as on the hardware, so it plays any number of notes. Voices are
// built when a key goes down and taken apart once their release has died away; they run in phase
// with nothing in particular, which the divider bank would — a small, deliberate liberty.
// Shared modulation (MG1, S/H, the general envelope through the voltage processors, the bender)
// reaches every voice through two control buses: one for pitch, one for cutoff.

import {
  type Ps3100Settings,
  RES_HIGHPASS,
  RESONATOR_Q,
  filterKeyCents,
  fixedDuty,
  keyFreq,
  keyLevel,
  ps3100Settings,
} from '../core/ps3100';
import { comparatorCurve, pwmBias } from '../core/sh101';
import { fourier, pinkNoise, pulseSamples } from '../core/synth';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

const LOOKAHEAD = 0.1;
const TICK_MS = 25;

interface Voice {
  note: number;
  osc: OscillatorNode;
  /** PWM: saw + bias → comparator (null for the other waves). */
  pwIn: GainNode | null;
  vcf: BiquadFilterNode;
  vca: GainNode;
  level: GainNode;
  env: ConstantSourceNode;
  expand: GainNode;
  /** Key still physically down. */
  down: boolean;
  /** Set once the release has finished and the voice is being taken apart. */
  ending?: ReturnType<typeof setTimeout>;
}

export class Ps3100Unit extends Unit implements Playable {
  private s!: Ps3100Settings;
  private readonly voices = new Map<number, Voice>();
  private readonly pulseWaves = new Map<number, PeriodicWave>();
  private readonly curve = comparatorCurve();
  private readonly timer: ReturnType<typeof setInterval>;
  private nextSh = 0;
  private nextAuto = 0;

  // Voice bus and resonators
  private readonly bus = this.ctx.createGain();
  private readonly hp1 = this.ctx.createBiquadFilter();
  private readonly hp2 = this.ctx.createBiquadFilter();
  private readonly dry = this.ctx.createGain();
  private readonly wet = this.ctx.createGain();
  private readonly resonators = [0, 1, 2].map(() => this.ctx.createBiquadFilter());
  private readonly resCv = this.ctx.createGain();
  private readonly resMg2 = this.ctx.createGain();
  private readonly resGeg = this.ctx.createGain();
  private readonly afterRes = this.ctx.createGain();
  private readonly directOut = this.ctx.createGain();
  // Total signal modifiers
  private readonly amp = this.ctx.createGain();
  private readonly amDepth = this.ctx.createGain();
  private readonly ensDry = this.ctx.createGain();
  private readonly ensWet = this.ctx.createGain();
  private readonly ensDelays = [0, 1, 2].map(() => this.ctx.createDelay(0.05));
  private readonly ensLfos: OscillatorNode[] = [];
  private readonly ensSum = this.ctx.createGain();
  private readonly vca2 = this.ctx.createGain();
  private readonly gegToVca = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();
  private readonly phonesOut = this.ctx.createGain();
  // Control: pitch and cutoff buses every voice listens to
  private readonly pitchCv = this.ctx.createGain();
  private readonly cutoffCv = this.ctx.createGain();
  private readonly pwmCv = this.ctx.createGain();
  private readonly pwBias = this.ctx.createConstantSource();
  // Modulation generators, S/H, general envelope, bender
  private readonly mg1Osc = this.ctx.createOscillator();
  private readonly mg1OscGate = this.ctx.createGain();
  private readonly pink = this.ctx.createBufferSource();
  private readonly white = this.ctx.createBufferSource();
  private readonly pinkGate = this.ctx.createGain();
  private readonly whiteGate = this.ctx.createGain();
  private readonly mg1 = this.ctx.createGain();
  private readonly mg2 = this.ctx.createOscillator();
  private readonly sh = this.ctx.createConstantSource();
  private readonly geg = this.ctx.createConstantSource();
  private readonly bend = this.ctx.createConstantSource();
  private readonly fmMg1 = this.ctx.createGain();
  private readonly fmSh = this.ctx.createGain();
  private readonly cutMg1 = this.ctx.createGain();
  private readonly cutSh = this.ctx.createGain();
  private readonly vp1 = this.ctx.createGain();
  private readonly vp2 = this.ctx.createGain();
  private readonly pwmMg1 = this.ctx.createGain();
  private readonly bendCents = this.ctx.createGain();
  /** Keys down, for the general envelope's single trigger. */
  private held = 0;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;
    this.outs['phones'] = this.phonesOut;
    this.outs['direct'] = this.directOut;

    // Resonator board: 2-pole input high-pass (≈58 Hz), then dry (RES OUT 2) and the three
    // band-passes summed (RES OUT 1), crossfaded by RESONANCE INTENSITY.
    for (const hp of [this.hp1, this.hp2]) {
      hp.type = 'highpass';
      hp.frequency.value = RES_HIGHPASS;
      hp.Q.value = -3.01;
    }
    this.bus.gain.value = 0.3; // many keys at once: headroom (MAIN • REC limits the rest)
    this.bus.connect(this.hp1).connect(this.hp2);
    this.hp2.connect(this.dry).connect(this.afterRes);
    for (const r of this.resonators) {
      r.type = 'bandpass';
      // BiquadFilter band-pass Q is the plain ratio f / bandwidth.
      r.Q.value = RESONATOR_Q;
      this.hp2.connect(r).connect(this.wet);
      this.resCv.connect(r.detune);
    }
    this.wet.connect(this.afterRes);
    this.resMg2.connect(this.resCv);
    this.resGeg.connect(this.resCv);
    this.afterRes.connect(this.directOut);

    // Amplitude modulator: gain = 1 − depth/2 + MG2 · depth/2.
    this.afterRes.connect(this.amp);
    this.mg2.connect(this.amDepth).connect(this.amp.gain);

    // Ensemble: three short delays swept 120° apart (slow chorus plus a faster shimmer), summed
    // with the dry signal; the switch crossfades it in.
    this.amp.connect(this.ensDry).connect(this.vca2);
    this.ensDelays.forEach((d, i) => {
      d.delayTime.value = 0.012;
      this.amp.connect(d).connect(this.ensSum);
      for (const [rate, depth] of [
        [0.55, 0.004],
        [6.1, 0.0004],
      ]) {
        const lfo = ctx.createOscillator();
        const g = ctx.createGain();
        lfo.frequency.value = rate;
        g.gain.value = depth;
        lfo.connect(g).connect(d.delayTime);
        // Phase: start each sweep a third of a cycle later.
        lfo.start(ctx.currentTime + i / 3 / rate);
        this.ensLfos.push(lfo);
      }
    });
    this.ensSum.gain.value = 0.45;
    this.ensSum.connect(this.ensWet).connect(this.vca2);

    // VCA 2 under the general envelope (when its switch is on), then the outputs.
    this.geg.connect(this.gegToVca).connect(this.vca2.gain);
    this.vca2.connect(this.volume);
    this.vca2.connect(this.phonesOut);

    // MG1: an oscillator (saws, triangle, rectangle) or pink / white noise.
    this.mg1Osc.connect(this.mg1OscGate).connect(this.mg1);
    for (const [src, gate, data] of [
      [this.pink, this.pinkGate, pinkNoise(ctx.sampleRate * 2)],
      [this.white, this.whiteGate, this.whiteNoise(ctx.sampleRate * 2)],
    ] as const) {
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data, 0);
      src.buffer = buf;
      src.loop = true;
      src.connect(gate).connect(this.mg1);
    }
    this.mg2.type = 'sine';

    // Control buses
    this.mg1.connect(this.fmMg1).connect(this.pitchCv);
    this.sh.connect(this.fmSh).connect(this.pitchCv);
    this.mg1.connect(this.cutMg1).connect(this.cutoffCv);
    this.sh.connect(this.cutSh).connect(this.cutoffCv);
    this.geg.connect(this.vp1).connect(this.cutoffCv);
    this.geg.connect(this.vp2).connect(this.pitchCv);
    this.geg.connect(this.resGeg);
    this.mg2.connect(this.resMg2);
    this.bend.connect(this.bendCents).connect(this.pitchCv);
    this.bendCents.gain.value = 200; // the lever bends ±2 semitones
    // PWM: comparator input = (saw + bias + MG1) / 2
    this.pwBias.connect(this.pwmCv);
    this.mg1.connect(this.pwmMg1).connect(this.pwmCv);

    for (const c of [this.sh, this.geg, this.bend, this.pwBias]) c.offset.value = 0;
    for (const src of this.sources()) src.start();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = ps3100Settings(p));
    const ctx = this.ctx;

    // Voices already sounding follow the knobs.
    if (prev && (prev.wave !== s.wave || prev.ratio !== s.ratio)) {
      for (const v of this.voices.values()) this.retune(v, true);
    }
    for (const v of this.voices.values()) this.retune(v, false);

    glide(this.pwBias.offset, 0, ctx);
    glide(this.pwmMg1.gain, s.wave === 'pwm' ? -pwmBias(0.5 - s.pwmDepth) : 0, ctx);
    glide(this.fmMg1.gain, s.fmMg1, ctx);
    glide(this.fmSh.gain, s.fmSh, ctx);
    glide(this.cutMg1.gain, s.cutMg1, ctx);
    glide(this.cutSh.gain, s.cutSh, ctx);
    glide(this.vp1.gain, s.vp1, ctx);
    glide(this.vp2.gain, s.vp2, ctx);

    // Resonators
    s.peaks.forEach((f, i) => glide(this.resonators[i].frequency, f, ctx));
    // Three band-passes at unity peak gain sit lower than the dry signal: make up the level.
    glide(this.wet.gain, s.resIntensity * 2.2, ctx);
    glide(this.dry.gain, 1 - s.resIntensity, ctx);
    glide(this.resMg2.gain, s.resMg2 ? 1200 : 0, ctx);
    glide(this.resGeg.gain, s.resExt, ctx);

    // Modulation generators
    glide(this.mg1Osc.frequency, s.mg1Rate, ctx);
    const osc = s.mg1Wave !== 'pink' && s.mg1Wave !== 'white';
    if (s.mg1Wave === 'triangle') this.mg1Osc.type = 'triangle';
    else if (s.mg1Wave === 'square') this.mg1Osc.type = 'square';
    else if (osc) this.mg1Osc.type = 'sawtooth';
    glide(this.mg1OscGate.gain, osc ? (s.mg1Wave === 'sawDown' ? -1 : 1) : 0, ctx, 0.005);
    glide(this.pinkGate.gain, s.mg1Wave === 'pink' ? 2.5 : 0, ctx, 0.005);
    glide(this.whiteGate.gain, s.mg1Wave === 'white' ? 1 : 0, ctx, 0.005);
    glide(this.mg2.frequency, s.mg2Rate, ctx);

    glide(this.amDepth.gain, s.am / 2, ctx);
    glide(this.amp.gain, 1 - s.am / 2, ctx);
    glide(this.ensDry.gain, s.ensemble ? 0.75 : 1, ctx);
    glide(this.ensWet.gain, s.ensemble ? 1 : 0, ctx);
    glide(this.vca2.gain, s.gegVca ? 0 : 1, ctx, 0.01);
    glide(this.gegToVca.gain, s.gegVca ? 1 : 0, ctx, 0.01);

    glide(this.volume.gain, s.volume, ctx);
    glide(this.phonesOut.gain, s.phones, ctx);
    glide(this.directOut.gain, s.direct, ctx);

    // KBD HOLD off lets go of keys no longer down.
    if (prev?.kbdHold && !s.kbdHold) {
      for (const v of this.voices.values()) if (!v.down) this.release(v, ctx.currentTime);
    }
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number) {
    const t = this.ctx.currentTime;
    const s = this.s;
    let v = this.voices.get(note);
    if (v?.ending) {
      clearTimeout(v.ending);
      v.ending = undefined;
    }
    if (!v) {
      v = this.voice(note);
      this.voices.set(note, v);
    }
    v.down = true;
    // The key's own envelope: attack from wherever it is, then decay to sustain.
    const o = v.env.offset;
    holdAt(o, t);
    o.linearRampToValueAtTime(1, t + s.attack);
    o.setTargetAtTime(s.sustain, t + s.attack, s.decay / 4);

    this.held++;
    if (s.kbdTrigger === 'multi' || (s.kbdTrigger === 'single' && this.held === 1)) {
      this.gegOn(t);
    }
  }

  noteOff(note: number) {
    const v = this.voices.get(note);
    if (!v || !v.down) return;
    v.down = false;
    this.held = Math.max(0, this.held - 1);
    const t = this.ctx.currentTime;
    if (!this.s.kbdHold) this.release(v, t);
    if (!this.held && this.s.kbdTrigger !== 'off') this.gegOff(t);
  }

  allNotesOff() {
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      v.down = false;
      this.release(v, t);
    }
    this.held = 0;
    this.gegOff(t);
  }

  pitchBend(amount: number) {
    glide(this.bend.offset, amount, this.ctx, 0.01);
  }

  // ── Voices ────────────────────────────────────────────

  private voice(note: number): Voice {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const vcf = ctx.createBiquadFilter();
    const vca = ctx.createGain();
    const level = ctx.createGain();
    const env = ctx.createConstantSource();
    const expand = ctx.createGain();
    vcf.type = 'lowpass';
    vca.gain.value = 0;
    env.offset.value = 0;
    env.connect(vca.gain);
    env.connect(expand).connect(vcf.detune);
    this.pitchCv.connect(osc.detune);
    this.cutoffCv.connect(vcf.detune);
    vcf.connect(vca).connect(level).connect(this.bus);
    const v: Voice = { note, osc, pwIn: null, vcf, vca, level, env, expand, down: true };
    this.retune(v, true);
    osc.start();
    env.start();
    return v;
  }

  /** Sets a voice's wave (when `rewire`), pitch, filter and level from the current settings. */
  private retune(v: Voice, rewire: boolean) {
    const s = this.s;
    const ctx = this.ctx;
    if (rewire) {
      v.osc.disconnect();
      v.pwIn?.disconnect();
      v.pwIn = null;
      if (s.wave === 'pwm') {
        // A comparator on the saw, its threshold swung by MG1 (see the SH-101's pwmBias).
        v.osc.type = 'sawtooth';
        const pwIn = ctx.createGain();
        const shaper = ctx.createWaveShaper();
        pwIn.gain.value = 0.5;
        shaper.curve = this.curve;
        v.osc.connect(pwIn);
        this.pwmCv.connect(pwIn);
        pwIn.connect(shaper).connect(v.vcf);
        v.pwIn = pwIn;
      } else {
        const duty = fixedDuty(s.wave);
        if (duty === null) v.osc.type = s.wave === 'saw' ? 'sawtooth' : 'triangle';
        else if (duty === 0.5) v.osc.type = 'square';
        else v.osc.setPeriodicWave(this.pulseWave(duty));
        v.osc.connect(v.vcf);
      }
    }
    glide(v.osc.frequency, keyFreq(v.note, s), ctx, 0.005);
    glide(v.vcf.frequency, s.cutoff, ctx);
    glide(v.vcf.Q, s.peak, ctx);
    v.vcf.detune.value = filterKeyCents(v.note, s.kbdBalance);
    glide(v.expand.gain, s.expand, ctx);
    glide(v.level.gain, keyLevel(v.note, s.kbdVolBalance), ctx);
  }

  private pulseWave(duty: number): PeriodicWave {
    let w = this.pulseWaves.get(duty);
    if (!w) {
      const { real, imag } = fourier(pulseSamples(duty), 64);
      w = this.ctx.createPeriodicWave(real, imag);
      this.pulseWaves.set(duty, w);
    }
    return w;
  }

  private release(v: Voice, t: number) {
    const time = this.s.releaseOn ? this.s.decay : 0.012;
    holdAt(v.env.offset, t);
    v.env.offset.setTargetAtTime(0, t, time / 4);
    clearTimeout(v.ending);
    // Take the voice apart once it has died away (five time constants: under 1 %).
    v.ending = setTimeout(() => this.drop(v), (time * 1.25 + 0.05) * 1000);
  }

  private drop(v: Voice) {
    if (this.voices.get(v.note) !== v) return;
    this.voices.delete(v.note);
    v.osc.stop();
    v.env.stop();
    for (const n of [v.osc, v.pwIn, v.vcf, v.vca, v.level, v.env, v.expand]) n?.disconnect();
  }

  // ── General envelope, S/H clock, AUTO ─────────────────

  private gegOn(t: number) {
    const s = this.s;
    const o = this.geg.offset;
    holdAt(o, t);
    o.setValueAtTime(o.value, t + s.gegDelay);
    o.linearRampToValueAtTime(1, t + s.gegDelay + s.gegAttack);
  }

  private gegOff(t: number) {
    const o = this.geg.offset;
    holdAt(o, t);
    o.setTargetAtTime(0, t, this.s.gegRelease / 4);
  }

  private schedule() {
    const s = this.s;
    if (!s) return;
    const now = this.ctx.currentTime;
    // Sample & hold: a fresh random level each clock (synchronised to MG1 when SYNCHRO is on).
    const shPeriod = 1 / (s.shSync ? s.mg1Rate : s.shRate);
    if (this.nextSh < now) this.nextSh = now + 0.005;
    while (this.nextSh < now + LOOKAHEAD) {
      this.sh.offset.setValueAtTime(Math.random() * 2 - 1, this.nextSh);
      this.nextSh += shPeriod;
    }
    // AUTO: the general envelope fires by itself on MG2's clock.
    if (!s.gegAuto) return;
    const period = 1 / s.mg2Rate;
    if (this.nextAuto < now) this.nextAuto = now + 0.005;
    while (this.nextAuto < now + LOOKAHEAD) {
      this.gegOn(this.nextAuto);
      const off = this.nextAuto + period / 2;
      holdAt(this.geg.offset, off);
      this.geg.offset.setTargetAtTime(0, off, s.gegRelease / 4);
      this.nextAuto += period;
    }
  }

  override status(): string | null {
    return `${this.voices.size} voice${this.voices.size === 1 ? '' : 's'}`;
  }

  private sources(): AudioScheduledSourceNode[] {
    return [
      this.mg1Osc,
      this.pink,
      this.white,
      this.mg2,
      this.sh,
      this.geg,
      this.bend,
      this.pwBias,
    ];
  }

  private whiteNoise(n: number): Float32Array<ArrayBuffer> {
    return Float32Array.from({ length: n }, () => Math.random() * 2 - 1);
  }

  override dispose() {
    clearInterval(this.timer);
    for (const v of [...this.voices.values()]) {
      clearTimeout(v.ending);
      this.drop(v);
    }
    for (const src of [...this.sources(), ...this.ensLfos]) src.stop();
    super.dispose();
  }
}
