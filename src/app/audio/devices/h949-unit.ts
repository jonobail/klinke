// H949 harmonizer, following the service manual's block diagrams (S2, S3) and technical section:
//
//   send → 15 kHz → (+) → ADC overload → REPEAT gate → memory ─┬→ DELAY ONLY tap → 15 kHz → DLY ONLY
//            ↑                            (REPEAT: the 0.4 s   ├→ OUTA ─ splice A ─┐
//            │                             memory loops)       ├→ OUTB ─ splice B ─┼→ 15 kHz → MAIN
//            │                                                 ├→ sweep (FLANGE / RANDOM) ─┤
//            │                                                 └→ FIXED DELAY (DELAY, FLANGE) ─┘
//            └── EQ LOW / EQ HI ←─ MAIN FB × MAIN + DLY FB × DLY ONLY
//
// Pitch change is two DelayNodes reading the memory with their delay drifting through the splice
// window (a looped ramp, the "POINTER"), half a window apart, crossfaded by the splice curves.
// The dbx 2:1 compander pair is left out (it hides converter noise a DelayNode doesn't have).

import { HEADROOM, softClipCurve } from '../../core/mf104';
import { BUTTERWORTH4, qDb } from '../../core/devices/filter-math';
import {
  FLANGE_FIXED,
  FLANGE_MAX,
  FLANGE_MIN,
  type H949Settings,
  MEMORY_SECONDS,
  h949Settings,
  rampCycle,
  spliceCurves,
  wanderNoise,
} from '../../core/devices/h949';
import { type Params, glide } from '../unit';
import { RackUnit } from './rack-unit';

const FILTER_HZ = 15e3;
const MAX_DELAY = 0.5; // 393.75 ms of switches + the window
const NOISE_RATE = 3000;

export class H949Unit extends RackUnit {
  private s?: H949Settings;
  private readonly inSum = this.ctx.createGain();
  private readonly adcIn = this.ctx.createGain();
  private readonly adc = this.ctx.createWaveShaper();
  private readonly writeGate = this.ctx.createGain();
  private readonly memory = this.ctx.createGain();
  private readonly memLoop = this.ctx.createDelay(1);
  private readonly repeat = this.ctx.createGain();

  private readonly dlyTap = this.ctx.createDelay(MAX_DELAY);
  private readonly dlyOut = this.ctx.createGain();
  private readonly dlyWet = this.ctx.createGain();
  private readonly dlyDry = this.ctx.createGain();

  private readonly ramp = this.ctx.createBufferSource();
  private readonly dir = this.ctx.createGain();
  private readonly voiceA = this.ctx.createDelay(MAX_DELAY);
  private readonly voiceB = this.ctx.createDelay(MAX_DELAY);
  private readonly posA = this.ctx.createGain();
  private readonly posB = this.ctx.createGain();
  private readonly shapePosB = this.ctx.createWaveShaper();
  private readonly shapeGainA = this.ctx.createWaveShaper();
  private readonly shapeGainB = this.ctx.createWaveShaper();
  private readonly spliceA = this.ctx.createGain();
  private readonly spliceB = this.ctx.createGain();
  private readonly pitchOn = this.ctx.createGain();

  private readonly sweep = this.ctx.createDelay(MAX_DELAY);
  private readonly sweepOn = this.ctx.createGain();
  private readonly flangeLfo = this.ctx.createOscillator();
  private readonly flangeDepth = this.ctx.createGain();
  private readonly noise = this.ctx.createBufferSource();
  private readonly noiseDepth = this.ctx.createGain();

  private readonly fixed = this.ctx.createDelay(MAX_DELAY);
  private readonly fixedOn = this.ctx.createGain();

  private readonly main = this.ctx.createGain();
  private readonly mainFb = this.ctx.createGain();
  private readonly dlyFb = this.ctx.createGain();
  private readonly eqLow = this.ctx.createBiquadFilter();
  private readonly eqHigh = this.ctx.createBiquadFilter();
  private algorithm = 0;

  constructor(ctx: AudioContext) {
    super(ctx);
    const sr = ctx.sampleRate;

    // Input → ADC (overload: unity-gain soft clip, so feedback can't run away) → memory
    this.send.connect(this.lowpass(0)).connect(this.lowpass(1)).connect(this.inSum);
    this.adcIn.gain.value = 1 / HEADROOM;
    this.adc.curve = softClipCurve();
    this.inSum.connect(this.adcIn).connect(this.adc).connect(this.writeGate).connect(this.memory);
    // REPEAT: a whole number of samples, so the frozen loop doesn't dull on every pass.
    this.memLoop.delayTime.value = Math.round(MEMORY_SECONDS * sr) / sr;
    this.repeat.gain.value = 0;
    this.memory.connect(this.memLoop).connect(this.repeat).connect(this.memory);

    // DELAY ONLY output (its own jack; LINE OUT passes the input through)
    const dlyFiltered = this.memory
      .connect(this.dlyTap)
      .connect(this.lowpass(0))
      .connect(this.lowpass(1));
    dlyFiltered.connect(this.dlyWet).connect(this.dlyOut);
    this.in.connect(this.dlyDry).connect(this.dlyOut);
    this.outs['dly'] = this.dlyOut;

    // Pitch change: the pointer ramp drives both read positions and the splice gains
    const buf = ctx.createBuffer(1, sr, sr);
    buf.copyToChannel(rampCycle(sr), 0);
    this.ramp.buffer = buf;
    this.ramp.loop = true;
    this.ramp.playbackRate.value = 0;
    this.ramp.connect(this.dir);
    this.dir.connect(this.posA).connect(this.voiceA.delayTime);
    this.dir.connect(this.shapePosB).connect(this.posB).connect(this.voiceB.delayTime);
    this.dir.connect(this.shapeGainA).connect(this.spliceA.gain);
    this.dir.connect(this.shapeGainB).connect(this.spliceB.gain);
    this.spliceA.gain.value = 0;
    this.spliceB.gain.value = 0;
    this.memory.connect(this.voiceA).connect(this.spliceA).connect(this.pitchOn);
    this.memory.connect(this.voiceB).connect(this.spliceB).connect(this.pitchOn);
    this.pitchOn.connect(this.main);
    this.ramp.start();

    // FLANGE / RANDOM sweep, and the fixed delay
    this.flangeLfo.type = 'triangle';
    this.flangeLfo.frequency.value = 0;
    this.flangeDepth.gain.value = (FLANGE_MAX - FLANGE_MIN) / 2;
    this.flangeLfo.connect(this.flangeDepth).connect(this.sweep.delayTime);
    const nbuf = ctx.createBuffer(1, NOISE_RATE * 30, NOISE_RATE);
    nbuf.copyToChannel(wanderNoise(30, NOISE_RATE), 0);
    this.noise.buffer = nbuf;
    this.noise.loop = true;
    this.noise.connect(this.noiseDepth).connect(this.sweep.delayTime);
    this.memory.connect(this.sweep).connect(this.sweepOn).connect(this.main);
    this.memory.connect(this.fixed).connect(this.fixedOn).connect(this.main);
    this.flangeLfo.start();
    this.noise.start();

    // MAIN output and the feedback EQ
    this.main.connect(this.lowpass(0)).connect(this.lowpass(1)).connect(this.ret);
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 250;
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 3000;
    this.ret.connect(this.mainFb).connect(this.eqLow);
    dlyFiltered.connect(this.dlyFb).connect(this.eqLow);
    this.eqLow.connect(this.eqHigh).connect(this.inSum);
  }

  protected apply(p: Params) {
    const first = !this.s;
    const s = (this.s = h949Settings(p));
    const ctx = this.ctx;
    const bypass = p['bypass'] >= 0.5;

    glide(this.writeGate.gain, s.repeat ? 0 : 1, ctx, 0.005);
    glide(this.repeat.gain, s.repeat ? 1 : 0, ctx, 0.005);
    this.setDelay(this.dlyTap, s.dlySeconds, first);
    glide(this.dlyWet.gain, bypass ? 0 : 1, ctx, 0.01);
    glide(this.dlyDry.gain, bypass ? 1 : 0, ctx, 0.01);

    // Pitch change
    if (this.algorithm !== s.algorithm) {
      this.algorithm = s.algorithm;
      const c = spliceCurves(s.algorithm as 1 | 2);
      this.shapeGainA.curve = c.gainA;
      this.shapeGainB.curve = c.gainB;
      this.shapePosB.curve = c.posB;
    }
    const half = s.window / 2;
    this.setDelay(this.voiceA, s.base + half, first);
    this.setDelay(this.voiceB, s.base + half, first);
    glide(this.posA.gain, half, ctx);
    glide(this.posB.gain, half, ctx);
    glide(this.dir.gain, s.direction, ctx, 0.005);
    glide(this.ramp.playbackRate, s.spliceHz, ctx);
    glide(this.pitchOn.gain, s.pitchMode ? 1 : 0, ctx, 0.01);

    // FLANGE / RANDOM
    const sweeping = s.fn === 'FLANGE' || s.fn === 'RANDOM';
    this.setDelay(this.sweep, s.base + FLANGE_FIXED, first);
    glide(this.flangeLfo.frequency, s.flangeHz, ctx);
    glide(this.flangeDepth.gain, s.fn === 'FLANGE' ? (FLANGE_MAX - FLANGE_MIN) / 2 : 0, ctx);
    glide(this.noiseDepth.gain, s.randomDepth, ctx);
    glide(this.sweepOn.gain, sweeping ? 1 : 0, ctx, 0.01);

    // Fixed delay: the MAIN switches in DELAY; + 12.5 ms through the phase-shift network
    // (taken as a polarity inversion) in FLANGE.
    this.setDelay(this.fixed, s.fn === 'FLANGE' ? s.base + FLANGE_FIXED : s.base, first);
    glide(this.fixedOn.gain, s.fn === 'DELAY' ? 1 : s.fn === 'FLANGE' ? -1 : 0, ctx, 0.01);

    glide(this.mainFb.gain, s.mainFb, ctx);
    glide(this.dlyFb.gain, s.dlyFb, ctx);
    glide(this.eqLow.gain, s.eqLowDb, ctx);
    glide(this.eqHigh.gain, s.eqHighDb, ctx);
  }

  override dispose() {
    this.ramp.stop();
    this.flangeLfo.stop();
    this.noise.stop();
    super.dispose();
  }

  private setDelay(node: DelayNode, seconds: number, first: boolean) {
    if (first) node.delayTime.value = seconds;
    else glide(node.delayTime, seconds, this.ctx, 0.03);
  }

  private lowpass(section: 0 | 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = FILTER_HZ;
    f.Q.value = qDb(BUTTERWORTH4[section]);
    return f;
  }
}
