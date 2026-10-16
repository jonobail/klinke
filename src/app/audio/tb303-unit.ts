// TB-303 voice and sequencer, after the service notes' block diagram (p.3) and circuit (p.5):
//
//   SEQUENCER / KEYS → CV (SLIDE: RC glide) → VCO ─ WAVE FORM: saw, or square made from it (Q8)
//     → VCF (4-pole ladder; CUT OFF FREQ, RESONANCE) → VCA → VOLUME → OUTPUT
//   ENV GEN (decay only) → ENV MOD → VCF;  on accented notes its decay is forced to the minimum
//   ACCENT: the envelope × ACCENT → VCA (louder) and, smoothed by R46 / C13, → VCF (the sweep)
//   VCA ENV GEN: its own fixed envelope, opened by the gate
//
// The ladder is two cascaded 2-pole low-passes, the second carrying the resonance. The
// sequencer runs on sixteenths of the song tempo; while it runs, a key played transposes it.

import { noteFreq } from '../core/sound';
import { MonoKeys } from '../core/synth';
import {
  BASE_NOTE,
  DECAY_MIN,
  type Pattern,
  SLIDE_TAU,
  SWEEP_TAU,
  type StepPlay,
  type Tb303Settings,
  decayTau,
  encodeStatus,
  patternsFromText,
  resolvePattern,
  stepSeconds,
  tb303Settings,
} from '../core/tb303';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

/** How far ahead the clock schedules (s) and how often it wakes up (ms). */
const LOOKAHEAD = 0.1;
const TICK_MS = 25;
/** The VCA envelope: a fast attack, a long fixed decay, a short release (our choice). */
const VCA_ATTACK = 0.003;
const VCA_DECAY_TAU = 1.2;
const VCA_RELEASE_TAU = 0.006;
/** Note voices this unit sends from NOTE OUT for sequenced notes (apart from the engine's own). */
const SEQ_VOICE = 303_000;

export class Tb303Unit extends Unit implements Playable {
  private s!: Tb303Settings;
  private readonly keys = new MonoKeys('last');
  private patterns: Pattern[] = patternsFromText(undefined);
  private bpm = 120;
  private running = false;
  private nextTick = 0;
  private step = 0;
  /** The pattern playing (a new choice waits for the end of the pattern, as on the hardware). */
  private playing = 0;
  private transpose = 0;
  /** Steps scheduled ahead, so the panel lights the one actually sounding. */
  private queued: { t: number; step: number }[] = [];
  /** The step before held its gate open (in schedule order), so a SLIDE can glide on. */
  private seqHold = false;
  private seqVoice = 0;
  private sentNote: number | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly timer: ReturnType<typeof setInterval>;

  private readonly saw = this.ctx.createOscillator();
  private readonly shaper = this.ctx.createWaveShaper();
  private readonly dcBlock = this.ctx.createBiquadFilter();
  private readonly sawLevel = this.ctx.createGain();
  private readonly squareLevel = this.ctx.createGain();
  private readonly vcf1 = this.ctx.createBiquadFilter();
  private readonly vcf2 = this.ctx.createBiquadFilter();
  private readonly filterCv = this.ctx.createGain();
  private readonly vca = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();
  // Control voltages
  private readonly pitch = this.ctx.createConstantSource();
  private readonly bend = this.ctx.createConstantSource();
  private readonly meg = this.ctx.createConstantSource();
  private readonly vcaEnv = this.ctx.createConstantSource();
  private readonly envMod = this.ctx.createGain();
  private readonly accentGate = this.ctx.createGain();
  private readonly accentVca = this.ctx.createGain();
  private readonly sweep: IIRFilterNode;
  private readonly sweepDepth = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;

    // VCO: pitch CV in cents above the low C, plus TUNING (the detune value) and the bend.
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = noteFreq(BASE_NOTE);
    this.pitch.connect(this.saw.detune);
    this.bend.connect(this.saw.detune);
    this.saw.connect(this.sawLevel);
    // Square: the saw squared up by a transistor (Q8), then AC-coupled.
    this.shaper.curve = Float32Array.from({ length: 2049 }, (_, i) =>
      Math.tanh(30 * (i / 1024 - 1)),
    );
    this.shaper.oversample = '4x';
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 10;
    this.dcBlock.Q.value = -3.01;
    this.saw.connect(this.shaper).connect(this.dcBlock).connect(this.squareLevel);

    // VCF → VCA → VOLUME
    this.vcf1.type = this.vcf2.type = 'lowpass';
    this.vcf1.Q.value = -3.01; // Web Audio Q is in dB: no peak on the first stage
    this.sawLevel.connect(this.vcf1);
    this.squareLevel.connect(this.vcf1);
    this.vcf1.connect(this.vcf2).connect(this.vca).connect(this.volume);
    this.filterCv.connect(this.vcf1.detune);
    this.filterCv.connect(this.vcf2.detune);
    this.vca.gain.value = 0;

    // Envelope → ENV MOD → VCF; the accented envelope → VCA and, through R46 / C13, → VCF.
    for (const c of [this.pitch, this.bend, this.meg, this.vcaEnv]) c.offset.value = 0;
    this.meg.connect(this.envMod).connect(this.filterCv);
    this.accentGate.gain.value = 0;
    this.meg.connect(this.accentGate);
    this.accentGate.connect(this.accentVca).connect(this.vca.gain);
    const a = Math.exp(-1 / (SWEEP_TAU * ctx.sampleRate)); // one-pole RC low-pass
    this.sweep = ctx.createIIRFilter([1 - a], [1, -a]);
    this.accentGate.connect(this.sweep).connect(this.sweepDepth).connect(this.filterCv);
    this.vcaEnv.connect(this.vca.gain);

    for (const src of this.sources()) src.start();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  set(p: Params) {
    const s = (this.s = tb303Settings(p));
    const ctx = this.ctx;
    glide(this.saw.detune, s.tuneCents, ctx);
    glide(this.sawLevel.gain, s.wave === 'saw' ? 0.5 : 0, ctx, 0.005);
    glide(this.squareLevel.gain, s.wave === 'square' ? 0.4 : 0, ctx, 0.005);
    const base = s.cutoff * Math.pow(2, s.envShift / 1200);
    glide(this.vcf1.frequency, base, ctx);
    glide(this.vcf2.frequency, base, ctx);
    glide(this.vcf2.Q, s.resonance, ctx);
    glide(this.envMod.gain, s.envDepth, ctx);
    glide(this.accentVca.gain, 0.7, ctx);
    glide(this.sweepDepth.gain, s.sweep, ctx);
    glide(this.volume.gain, s.volume, ctx);
    if (!this.running) this.playing = s.pattern;
  }

  override setTempo(bpm: number) {
    if (bpm > 0) this.bpm = bpm;
  }

  /** The patterns come back from the patch (the hardware keeps them on its back-up battery). */
  override setText(text: Record<string, string>) {
    this.patterns = patternsFromText(text);
  }

  override status(): string {
    const now = this.ctx.currentTime;
    while (this.queued.length > 1 && this.queued[1].t <= now) this.queued.shift();
    const head = this.queued[0];
    return encodeStatus(this.running, this.running && head && head.t <= now ? head.step : -1);
  }

  override command(name: string) {
    if (name === 'run') this.running ? this.stop() : this.start();
    else if (name === 'stop') this.stop();
  }

  // ── Keys ──────────────────────────────────────────────

  /**
   * Keys play the voice, last-note priority; a key pressed while another is held slides to it
   * without a new attack, as a tied slide does. While the pattern runs, a key transposes it by
   * its distance from C instead (C′ is an octave up).
   */
  noteOn(note: number) {
    const t = this.ctx.currentTime;
    if (this.running) {
      this.transpose = ((note % 12) + 12) % 12;
      return;
    }
    const { note: sound, trigger } = this.keys.press(note);
    this.setPitch(sound, t, trigger ? 0 : SLIDE_TAU);
    if (trigger) this.attack(t, false);
  }

  noteOff(note: number) {
    if (this.running) return;
    const t = this.ctx.currentTime;
    const { note: next, changed } = this.keys.lift(note);
    if (next === null) this.release(t);
    else if (changed) this.setPitch(next, t, SLIDE_TAU);
  }

  allNotesOff() {
    this.keys.clear();
    this.release(this.ctx.currentTime);
  }

  /** ±2 semitones, as the engine bends notes leaving NOTE OUT. */
  pitchBend(amount: number) {
    glide(this.bend.offset, amount * 200, this.ctx, 0.01);
  }

  // ── Sequencer ─────────────────────────────────────────

  private start() {
    this.keys.clear();
    this.release(this.ctx.currentTime);
    this.running = true;
    this.step = 0;
    this.transpose = 0;
    this.seqHold = false;
    this.playing = this.s?.pattern ?? 0;
    this.nextTick = this.ctx.currentTime + 0.05;
  }

  private stop() {
    this.running = false;
    this.queued = [];
    this.release(this.ctx.currentTime);
    this.sendOff(0);
  }

  private schedule() {
    if (!this.running || !this.s) return;
    const now = this.ctx.currentTime;
    if (this.nextTick < now) this.nextTick = now + 0.005;
    while (this.nextTick < now + LOOKAHEAD) {
      const len = stepSeconds(this.bpm);
      this.tick(this.nextTick, len);
      this.nextTick += len;
    }
  }

  private tick(t: number, len: number) {
    let pattern = this.patterns[this.playing];
    if (this.step >= pattern.length) {
      this.step = 0;
      this.playing = this.s.pattern; // a new pattern starts at the top of the loop
      pattern = this.patterns[this.playing];
    }
    const i = this.step++;
    this.queued.push({ t, step: i });
    if (this.queued.length > 64) this.queued.shift();
    this.playStep(resolvePattern(pattern)[i], t, len);
  }

  private playStep(play: StepPlay, t: number, len: number) {
    if (play.kind === 'note') {
      const note = play.note + this.transpose;
      const glideIn = play.legato && this.seqHold;
      this.setPitch(note, t, glideIn ? SLIDE_TAU : 0);
      if (!glideIn) this.attack(t, play.accent);
      this.sendOn(note, t);
    }
    this.seqHold = play.kind !== 'rest' && play.hold;
    if (play.kind === 'rest' || !play.hold) {
      this.release(t + len / 2); // the gate is half a step long
      this.sendOff(t + len / 2);
    }
  }

  // ── Pitch and envelopes ───────────────────────────────

  private setPitch(note: number, t: number, glideTau: number) {
    const o = this.pitch.offset;
    const cents = (note - BASE_NOTE) * 100;
    holdAt(o, t);
    if (glideTau > 0) o.setTargetAtTime(cents, t, glideTau);
    else o.setValueAtTime(cents, t);
  }

  /** A new note: both envelopes fire; an accent shortens the filter decay and adds its CV. */
  private attack(t: number, accent: boolean) {
    const s = this.s;
    const decay = decayTau(accent ? DECAY_MIN : s.decay);
    const m = this.meg.offset;
    holdAt(m, t);
    m.linearRampToValueAtTime(1, t + 0.003);
    m.setTargetAtTime(0, t + 0.003, decay);
    holdAt(this.accentGate.gain, t);
    this.accentGate.gain.setValueAtTime(accent ? s.accent : 0, t);
    const v = this.vcaEnv.offset;
    holdAt(v, t);
    v.linearRampToValueAtTime(0.55, t + VCA_ATTACK);
    v.setTargetAtTime(0, t + VCA_ATTACK, VCA_DECAY_TAU);
  }

  /** Gate off: the VCA closes (the filter envelope runs on, as it is decay-only). */
  private release(t: number) {
    holdAt(this.vcaEnv.offset, t);
    this.vcaEnv.offset.setTargetAtTime(0, t, VCA_RELEASE_TAU);
    holdAt(this.accentGate.gain, t);
    this.accentGate.gain.setTargetAtTime(0, t, VCA_RELEASE_TAU);
  }

  // ── NOTE OUT for sequenced notes ──────────────────────

  private sendOn(note: number, t: number) {
    this.later(t, () => {
      const old = this.sentNote;
      const oldVoice = SEQ_VOICE + this.seqVoice;
      this.seqVoice = (this.seqVoice + 1) % 1000;
      this.sentNote = note;
      this.emit({ type: 'on', voice: SEQ_VOICE + this.seqVoice, note, velocity: 0.8 });
      if (old !== null) this.emit({ type: 'off', voice: oldVoice, note: old }); // legato: after
    });
  }

  private sendOff(t: number) {
    this.later(t, () => {
      if (this.sentNote === null) return;
      this.emit({ type: 'off', voice: SEQ_VOICE + this.seqVoice, note: this.sentNote });
      this.sentNote = null;
    });
  }

  /** Runs `fn` when the audio clock reaches `t`. */
  private later(t: number, fn: () => void) {
    const ms = Math.max(0, (t - this.ctx.currentTime) * 1000);
    if (ms < 1) return fn();
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private sources(): AudioScheduledSourceNode[] {
    return [this.saw, this.pitch, this.bend, this.meg, this.vcaEnv];
  }

  override dispose() {
    clearInterval(this.timer);
    for (const id of this.timers) clearTimeout(id);
    for (const src of this.sources()) src.stop();
    super.dispose();
  }
}
