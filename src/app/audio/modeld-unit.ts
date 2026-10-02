// Model D voice, following the service manual's block diagram (dwg. 1429):
//
//   KBD → glide → OSC CONTROL ─┬→ OSC 1 ─┐
//   pitch wheel + modulation ──┼→ OSC 2 ─┤
//                              └(OSC 3 CTRL)→ OSC 3 ─┤
//                         NOISE (white | pink) ─────┼→ MIXER → VCF (24 dB) → VCA → VOL → out
//                         EXT INPUT ────────────────┘            ↑            ↑
//                                       filter contour, kbd 1/3 + 2/3,   loudness contour
//                                       modulation (FILTER MOD)
//
// MODULATION MIX pans between oscillator 3 and noise; the mod wheel sets how much of it reaches
// the oscillators (OSC MOD) and the filter (FILTER MOD). Like the hardware it's monophonic with
// low-note priority, the oscillators run free and the loudness contour gates them. The ladder
// filter is approximated by two cascaded 12 dB low-passes with a saturator in front, which is
// where an overdriven mixer (the OVERLOAD lamp) gets its grit.

import {
  BEND_SEMITONES,
  FILTER_MOD_CENTS,
  type ModelDSettings,
  OSC_MOD_CENTS,
  modelDSamples,
  modelDSettings,
} from '../core/modeld';
import { driveCurve, noteFreq } from '../core/sound';
import { MonoKeys, fourier, pinkNoise } from '../core/synth';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

const HARMONICS = 96;
/** Oscillator 3's reference pitch when it isn't following the keyboard. */
const FREE_NOTE = 60;

export class ModelDUnit extends Unit implements Playable {
  private readonly keys = new MonoKeys('low');
  private s!: ModelDSettings;
  private note = 48;
  private waves = ['', '', ''];
  private ratios = [0, 0, 0];
  private osc3Kbd = true;

  private readonly oscs = [0, 1, 2].map(() => this.ctx.createOscillator());
  private readonly oscLevels = [0, 1, 2].map(() => this.ctx.createGain());
  private readonly white = this.ctx.createBufferSource();
  private readonly pink = this.ctx.createBufferSource();
  private readonly whiteGate = this.ctx.createGain();
  private readonly pinkGate = this.ctx.createGain();
  private readonly noise = this.ctx.createGain();
  private readonly noiseLevel = this.ctx.createGain();
  private readonly ext = this.ctx.createGain();
  private readonly extLevel = this.ctx.createGain();
  private readonly mix = this.ctx.createGain();

  private readonly preDrive = this.ctx.createGain();
  private readonly drive = this.ctx.createWaveShaper();
  private readonly ladder1 = this.ctx.createBiquadFilter();
  private readonly ladder2 = this.ctx.createBiquadFilter();
  private readonly vca = this.ctx.createGain();
  private readonly a440 = this.ctx.createOscillator();
  private readonly a440Gate = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();

  // Control voltages, in cents
  private readonly pitchCv = this.ctx.createGain();
  private readonly osc3Follow = this.ctx.createGain();
  private readonly bend = this.ctx.createConstantSource();
  private readonly filterCv = this.ctx.createGain();
  private readonly kbdCv = this.ctx.createConstantSource();
  private readonly kbdTrack = this.ctx.createGain();
  private readonly filterEnv = this.ctx.createConstantSource();
  private readonly contourAmount = this.ctx.createGain();
  private readonly loudEnv = this.ctx.createConstantSource();
  // Modulation: MOD MIX pan → mod wheel → OSC MOD / FILTER MOD
  private readonly modFromOsc3 = this.ctx.createGain();
  private readonly modFromNoise = this.ctx.createGain();
  private readonly wheel = this.ctx.createGain();
  private readonly oscMod = this.ctx.createGain();
  private readonly filterMod = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.ext;
    this.output = this.volume;

    // Mixer
    this.oscs.forEach((o, i) => o.connect(this.oscLevels[i]).connect(this.mix));
    this.white.buffer = this.noiseBuffer(false);
    this.pink.buffer = this.noiseBuffer(true);
    for (const n of [this.white, this.pink]) n.loop = true;
    this.white.connect(this.whiteGate).connect(this.noise);
    this.pink.connect(this.pinkGate).connect(this.noise);
    this.noise.connect(this.noiseLevel).connect(this.mix);
    this.ext.connect(this.extLevel).connect(this.mix);
    this.analyser(this.mix); // the OVERLOAD lamp

    // Saturator → 24 dB low-pass → VCA (+ A-440 into the output amplifier) → volume
    this.preDrive.gain.value = 0.5;
    this.drive.curve = driveCurve(0.05);
    this.drive.oversample = '2x';
    this.ladder1.type = this.ladder2.type = 'lowpass';
    this.ladder1.Q.value = 0.54;
    this.vca.gain.value = 0;
    this.mix.connect(this.preDrive).connect(this.drive).connect(this.ladder1).connect(this.ladder2);
    this.ladder2.connect(this.vca).connect(this.volume);
    this.a440.frequency.value = 440;
    this.a440Gate.gain.value = 0;
    this.a440.connect(this.a440Gate).connect(this.volume);

    // Oscillator control: pitch wheel + modulation into all three (osc 3 only with OSC 3 CTRL)
    this.bend.offset.value = 0;
    this.bend.connect(this.pitchCv);
    this.pitchCv.connect(this.oscs[0].detune);
    this.pitchCv.connect(this.oscs[1].detune);
    this.pitchCv.connect(this.osc3Follow).connect(this.oscs[2].detune);

    // Filter control: contour + keyboard tracking + modulation into both ladder stages
    this.filterEnv.offset.value = 0;
    this.loudEnv.offset.value = 0;
    this.kbdCv.offset.value = 0;
    this.filterEnv.connect(this.contourAmount).connect(this.filterCv);
    this.kbdCv.connect(this.kbdTrack).connect(this.filterCv);
    this.filterCv.connect(this.ladder1.detune);
    this.filterCv.connect(this.ladder2.detune);
    this.loudEnv.connect(this.vca.gain);

    // Modulation bus
    this.oscs[2].connect(this.modFromOsc3).connect(this.wheel);
    this.noise.connect(this.modFromNoise).connect(this.wheel);
    this.wheel.connect(this.oscMod).connect(this.pitchCv);
    this.wheel.connect(this.filterMod).connect(this.filterCv);

    for (const src of this.sources()) src.start();
  }

  set(p: Params) {
    const s = (this.s = modelDSettings(p));
    const ctx = this.ctx;

    s.osc.forEach((o, i) => {
      if (this.waves[i] !== o.wave) {
        this.waves[i] = o.wave;
        const { real, imag } = fourier(modelDSamples(o.wave), HARMONICS);
        this.oscs[i].setPeriodicWave(ctx.createPeriodicWave(real, imag));
      }
      glide(this.oscLevels[i].gain, o.level, ctx);
    });
    const follow = s.osc3Kbd;
    glide(this.oscs[0].detune, s.tuneCents, ctx);
    glide(this.oscs[1].detune, s.tuneCents + s.osc[1].cents, ctx);
    glide(this.oscs[2].detune, (follow ? s.tuneCents : 0) + s.osc[2].cents, ctx);
    glide(this.osc3Follow.gain, follow ? 1 : 0, ctx, 0.005);
    if (s.osc.some((o, i) => o.ratio !== this.ratios[i]) || follow !== this.osc3Kbd) {
      this.ratios = s.osc.map((o) => o.ratio);
      this.osc3Kbd = follow;
      this.setPitch(this.note, 0);
    }

    glide(this.whiteGate.gain, s.noisePink ? 0 : 1, ctx, 0.005);
    glide(this.pinkGate.gain, s.noisePink ? 1.6 : 0, ctx, 0.005); // pink is quieter; match levels
    glide(this.noiseLevel.gain, s.noiseLevel, ctx);
    glide(this.extLevel.gain, s.extLevel, ctx);

    glide(this.ladder1.frequency, s.cutoff, ctx);
    glide(this.ladder2.frequency, s.cutoff, ctx);
    glide(this.ladder2.Q, s.emphasisQ, ctx);
    glide(this.contourAmount.gain, s.contourCents, ctx);
    glide(this.kbdTrack.gain, s.kbdTrack, ctx);

    glide(this.modFromOsc3.gain, 1 - s.modMix, ctx);
    glide(this.modFromNoise.gain, s.modMix, ctx);
    glide(this.wheel.gain, s.modWheel, ctx);
    glide(this.oscMod.gain, s.oscMod ? OSC_MOD_CENTS : 0, ctx);
    glide(this.filterMod.gain, s.filterMod ? FILTER_MOD_CENTS : 0, ctx);

    glide(this.volume.gain, s.volume, ctx);
    glide(this.a440Gate.gain, s.a440 ? 0.3 : 0, ctx, 0.005);
  }

  noteOn(note: number) {
    const { note: sound, trigger } = this.keys.press(note);
    this.setPitch(sound, this.s.glide);
    if (trigger) this.trigger();
  }

  noteOff(note: number) {
    const { note: next, changed } = this.keys.lift(note);
    if (next === null) this.release();
    else if (changed) this.setPitch(next, this.s.glide);
  }

  allNotesOff() {
    this.keys.clear();
    const t = this.ctx.currentTime;
    for (const env of [this.filterEnv, this.loudEnv]) {
      holdAt(env.offset, t);
      env.offset.setTargetAtTime(0, t, 0.01);
    }
  }

  pitchBend(amount: number) {
    glide(this.bend.offset, amount * BEND_SEMITONES * 100, this.ctx, 0.01);
  }

  override dispose() {
    for (const src of this.sources()) src.stop();
    super.dispose();
  }

  // ── Keyboard voltage and contours ─────────────────────

  private setPitch(note: number, glideTime: number) {
    this.note = note;
    const t = this.ctx.currentTime;
    const move = (param: AudioParam, value: number) => {
      holdAt(param, t);
      if (glideTime > 0) param.setTargetAtTime(value, t, glideTime);
      else param.setValueAtTime(value, t);
    };
    this.oscs.forEach((o, i) => {
      const followsKeys = i < 2 || this.osc3Kbd;
      move(o.frequency, noteFreq(followsKeys ? note : FREE_NOTE) * this.ratios[i]);
    });
    move(this.kbdCv.offset, (note - 60) * 100); // the filter's keyboard voltage, in cents
  }

  private trigger() {
    const t = this.ctx.currentTime;
    for (const [env, c] of [
      [this.filterEnv, this.s.filter],
      [this.loudEnv, this.s.loudness],
    ] as const) {
      holdAt(env.offset, t);
      env.offset.linearRampToValueAtTime(1, t + c.attack);
      env.offset.setTargetAtTime(c.sustain, t + c.attack, c.decay / 4);
    }
  }

  private release() {
    const t = this.ctx.currentTime;
    for (const [env, c] of [
      [this.filterEnv, this.s.filter],
      [this.loudEnv, this.s.loudness],
    ] as const) {
      holdAt(env.offset, t);
      // DECAY switch on: fall at the DECAY rate. Off: stop almost at once.
      env.offset.setTargetAtTime(0, t, this.s.decayOn ? c.decay / 4 : 0.004);
    }
  }

  private sources(): AudioScheduledSourceNode[] {
    return [
      ...this.oscs,
      this.white,
      this.pink,
      this.a440,
      this.bend,
      this.kbdCv,
      this.filterEnv,
      this.loudEnv,
    ];
  }

  private noiseBuffer(pink: boolean) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * 2, rate);
    if (pink) buffer.copyToChannel(pinkNoise(rate * 2), 0);
    else {
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}
