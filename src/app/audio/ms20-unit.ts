// MS-20 voice, following the service manual's block diagram:
//
//   KBD → portamento → VCO1 (tri / saw / PW pulse / noise) ─┐
//                      VCO2 (saw / square / narrow / ring) ─┴→ MIX ← EXT SIG IN
//   MIX → VCHPF (fc, peak) → VCLPF (fc, peak) → VCA → VOLUME → out
//
// MG (skewable triangle) and EG1 (delay / attack / release) modulate the VCO pitch; MG and EG2
// modulate both filter cutoffs; EG2 (hold / attack / decay / sustain / release) opens the VCA.
// Like the hardware, it's monophonic and the oscillators run all the time; the VCA does the
// gating. Modulation is summed into each node's `detune` param in cents, the Web Audio
// equivalent of the MS-20's exponential control-voltage inputs.

import { NARROW_DUTY, type Ms20Settings, mgSamples, ms20Settings } from '../core/ms20';
import { MonoKeys, fourier, pulseSamples } from '../core/synth';
import { driveCurve, noteFreq } from '../core/sound';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

/** Harmonics in the generated pulse / MG waves (the browser band-limits them per pitch). */
const HARMONICS = 96;

export class Ms20Unit extends Unit implements Playable {
  private readonly keys = new MonoKeys();
  private s!: Ms20Settings;
  /** Last note played; the VCOs stay on its pitch after release, as on the hardware. */
  private pitchNote = 48;
  private trigTime = 0;
  private vco1Shape = '';
  private vco2Shape = '';
  private mgSkew = -1;

  // Sound sources
  private readonly vco1 = this.ctx.createOscillator();
  private readonly vco2 = this.ctx.createOscillator();
  private readonly noise = this.ctx.createBufferSource();
  private readonly vco1Gate = this.ctx.createGain();
  private readonly noiseGate = this.ctx.createGain();
  private readonly vco2Gate = this.ctx.createGain();
  private readonly ring = this.ctx.createGain();
  private readonly ringGate = this.ctx.createGain();
  private readonly vco1Level = this.ctx.createGain();
  private readonly vco2Level = this.ctx.createGain();
  private readonly ext = this.ctx.createGain();
  private readonly mix = this.ctx.createGain();

  // Filters, VCA
  private readonly hpf = this.ctx.createBiquadFilter();
  private readonly lpf = this.ctx.createBiquadFilter();
  private readonly drive = this.ctx.createWaveShaper();
  private readonly vca = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();

  // Modulation sources and their intensity knobs
  private readonly mg = this.ctx.createOscillator();
  private readonly eg1 = this.ctx.createConstantSource();
  private readonly eg2 = this.ctx.createConstantSource();
  /** MIDI pitch bend (the MS-20 has no pitch wheel of its own), in cents. */
  private readonly bend = this.ctx.createConstantSource();
  private readonly mgToPitch = this.ctx.createGain();
  private readonly eg1ToPitch = this.ctx.createGain();
  private readonly mgToHpf = this.ctx.createGain();
  private readonly mgToLpf = this.ctx.createGain();
  private readonly eg2ToHpf = this.ctx.createGain();
  private readonly eg2ToLpf = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.ext;
    this.output = this.volume;

    // VCO1 → (osc | noise) → level
    this.noise.buffer = this.noiseBuffer();
    this.noise.loop = true;
    this.vco1.connect(this.vco1Gate).connect(this.vco1Level);
    this.noise.connect(this.noiseGate).connect(this.vco1Level);
    // VCO2 → (osc | ring) → level. The ring modulator multiplies VCO2 by VCO1.
    this.ring.gain.value = 0;
    this.vco2.connect(this.ring);
    this.vco1.connect(this.ring.gain);
    this.vco2.connect(this.vco2Gate).connect(this.vco2Level);
    this.ring.connect(this.ringGate).connect(this.vco2Level);

    this.mix.gain.value = 0.5;
    this.vco1Level.connect(this.mix);
    this.vco2Level.connect(this.mix);
    this.ext.connect(this.mix);

    // HPF → LPF in series, then a gentle saturator so a screaming PEAK distorts instead of
    // clipping digitally, then the VCA.
    this.hpf.type = 'highpass';
    this.lpf.type = 'lowpass';
    this.drive.curve = driveCurve(0.03);
    this.drive.oversample = '2x';
    this.vca.gain.value = 0;
    this.mix
      .connect(this.hpf)
      .connect(this.lpf)
      .connect(this.drive)
      .connect(this.vca)
      .connect(this.volume);

    // Modulation routing
    this.eg1.offset.value = 0;
    this.eg2.offset.value = 0;
    this.mg.connect(this.mgToPitch);
    this.mgToPitch.connect(this.vco1.detune);
    this.mgToPitch.connect(this.vco2.detune);
    this.bend.offset.value = 0;
    this.bend.connect(this.vco1.detune);
    this.bend.connect(this.vco2.detune);
    this.eg1.connect(this.eg1ToPitch);
    this.eg1ToPitch.connect(this.vco1.detune);
    this.eg1ToPitch.connect(this.vco2.detune);
    this.mg.connect(this.mgToHpf).connect(this.hpf.detune);
    this.mg.connect(this.mgToLpf).connect(this.lpf.detune);
    this.eg2.connect(this.eg2ToHpf).connect(this.hpf.detune);
    this.eg2.connect(this.eg2ToLpf).connect(this.lpf.detune);
    this.eg2.connect(this.vca.gain);

    for (const src of [this.vco1, this.vco2, this.noise, this.mg, this.eg1, this.eg2, this.bend])
      src.start();
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = ms20Settings(p));
    const ctx = this.ctx;

    this.setVco1Wave(s);
    this.setVco2Wave(s);
    if (!prev || prev.vco1Ratio !== s.vco1Ratio || prev.vco2Ratio !== s.vco2Ratio) {
      this.setPitch(this.pitchNote, 0);
    }
    glide(this.vco1.detune, s.tuneCents, ctx);
    glide(this.vco2.detune, s.tuneCents + s.vco2Cents, ctx);
    glide(this.vco1Level.gain, s.vco1Level, ctx);
    glide(this.vco2Level.gain, s.vco2Level, ctx);

    glide(this.hpf.frequency, s.hpfCutoff, ctx);
    glide(this.hpf.Q, s.hpfQ, ctx);
    glide(this.lpf.frequency, s.lpfCutoff, ctx);
    glide(this.lpf.Q, s.lpfQ, ctx);

    glide(this.mgToPitch.gain, s.fmMgCents, ctx);
    glide(this.eg1ToPitch.gain, s.fmEg1Cents, ctx);
    glide(this.mgToHpf.gain, s.hpfMgCents, ctx);
    glide(this.mgToLpf.gain, s.lpfMgCents, ctx);
    glide(this.eg2ToHpf.gain, s.hpfEg2Cents, ctx);
    glide(this.eg2ToLpf.gain, s.lpfEg2Cents, ctx);

    glide(this.mg.frequency, s.mgFreq, ctx);
    if (Math.abs(s.mgSkew - this.mgSkew) > 0.01) {
      this.mgSkew = s.mgSkew;
      this.mg.setPeriodicWave(this.wave(mgSamples(s.mgSkew)));
    }
    glide(this.volume.gain, s.volume, ctx);
  }

  noteOn(note: number) {
    const { trigger } = this.keys.press(note);
    this.setPitch(note, this.s.portamento);
    if (trigger) this.trigger();
  }

  noteOff(note: number) {
    const { note: next, changed } = this.keys.lift(note);
    if (next === null) this.release();
    else if (changed) this.setPitch(next, this.s.portamento);
  }

  allNotesOff() {
    this.keys.clear();
    const t = this.ctx.currentTime;
    for (const eg of [this.eg1, this.eg2]) {
      holdAt(eg.offset, t);
      eg.offset.setTargetAtTime(0, t, 0.01);
    }
  }

  /** ±2 semitones. */
  pitchBend(amount: number) {
    glide(this.bend.offset, amount * 200, this.ctx, 0.01);
  }

  override dispose() {
    for (const src of [this.vco1, this.vco2, this.noise, this.mg, this.eg1, this.eg2, this.bend])
      src.stop();
    super.dispose();
  }

  // ── Keyboard voltage and envelopes ────────────────────

  private setPitch(note: number, portamento: number) {
    this.pitchNote = note;
    const t = this.ctx.currentTime;
    const f = noteFreq(note);
    for (const [osc, ratio] of [
      [this.vco1, this.s.vco1Ratio],
      [this.vco2, this.s.vco2Ratio],
    ] as const) {
      holdAt(osc.frequency, t);
      if (portamento > 0) osc.frequency.setTargetAtTime(f * ratio, t, portamento);
      else osc.frequency.setValueAtTime(f * ratio, t);
    }
  }

  private trigger() {
    const t = this.ctx.currentTime;
    this.trigTime = t;
    const { eg1, eg2 } = this.s;

    // EG2: attack to full, decay to sustain.
    const o2 = this.eg2.offset;
    holdAt(o2, t);
    o2.linearRampToValueAtTime(1, t + Math.max(eg2.attack, 0.002));
    o2.setTargetAtTime(
      eg2.sustain,
      t + Math.max(eg2.attack, 0.002),
      Math.max(eg2.decay / 3, 0.002),
    );

    // EG1: back to zero, wait out DELAY, then attack to full and stay there while the key is down.
    const o1 = this.eg1.offset;
    holdAt(o1, t);
    o1.linearRampToValueAtTime(0, t + 0.003);
    if (eg1.delay > 0.003) o1.setValueAtTime(0, t + eg1.delay);
    o1.linearRampToValueAtTime(1, t + Math.max(eg1.delay, 0.003) + Math.max(eg1.attack, 0.002));
  }

  private release() {
    const t = this.ctx.currentTime;
    const { eg1, eg2 } = this.s;
    // EG2's HOLD keeps the envelope up for at least that long after the trigger.
    const at = Math.max(t, this.trigTime + eg2.hold);
    holdAt(this.eg2.offset, at);
    this.eg2.offset.setTargetAtTime(0, at, Math.max(eg2.release / 3, 0.002));
    holdAt(this.eg1.offset, t);
    this.eg1.offset.setTargetAtTime(0, t, Math.max(eg1.release / 3, 0.002));
  }

  // ── Wave forms ────────────────────────────────────────

  private setVco1Wave(s: Ms20Settings) {
    const shape = s.vco1Wave === 'pulse' ? `pulse:${s.vco1Duty.toFixed(3)}` : s.vco1Wave;
    if (shape === this.vco1Shape) return;
    this.vco1Shape = shape;
    if (s.vco1Wave === 'pulse') this.vco1.setPeriodicWave(this.wave(pulseSamples(s.vco1Duty)));
    else if (s.vco1Wave !== 'noise') this.vco1.type = s.vco1Wave;
    const noise = s.vco1Wave === 'noise';
    glide(this.vco1Gate.gain, noise ? 0 : 1, this.ctx, 0.005);
    glide(this.noiseGate.gain, noise ? 0.6 : 0, this.ctx, 0.005);
  }

  private setVco2Wave(s: Ms20Settings) {
    if (s.vco2Wave === this.vco2Shape) return;
    this.vco2Shape = s.vco2Wave;
    if (s.vco2Wave === 'sawtooth') this.vco2.type = 'sawtooth';
    else if (s.vco2Wave === 'narrow')
      this.vco2.setPeriodicWave(this.wave(pulseSamples(NARROW_DUTY)));
    else this.vco2.type = 'square'; // square, and the ring modulator's carrier
    const ring = s.vco2Wave === 'ring';
    glide(this.vco2Gate.gain, ring ? 0 : 1, this.ctx, 0.005);
    glide(this.ringGate.gain, ring ? 1 : 0, this.ctx, 0.005);
  }

  private wave(samples: Float32Array) {
    const { real, imag } = fourier(samples, HARMONICS);
    return this.ctx.createPeriodicWave(real, imag);
  }

  private noiseBuffer() {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * 2, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}
