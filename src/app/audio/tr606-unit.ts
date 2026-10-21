// TR-606 voices and sequencer:
//
//   BD: two damped sines (the first falling into pitch) ┐
//   SD: two damped sines + high-passed noise            │
//   LT / HT: one damped sine each                       ├─ instrument levels → VOLUME → OUTPUT
//   six squares ─┬─ band-pass ─ high-pass → CH / OH     │
//                └─ band-pass ─ high-pass → CY          ┘
//
// Each drum hit makes its own short-lived oscillators, so every hit starts from rest as a struck
// resonator does; the metal source and the noise run all the time and are gated per hit. A
// closed hi-hat chokes the open one. The sequencer runs on the song tempo at the pattern's
// scale; ACCENT lifts everything on an accented step.

import {
  ACCENT_VELOCITY,
  type Pattern,
  SOUND_NOTES,
  type Sound,
  type Tr606Settings,
  VOICE,
  encodeStatus,
  openHatTau,
  parseChain,
  patternIndex,
  patternsFromText,
  soundForNote,
  stepHits,
  stepSeconds,
  tr606Settings,
} from '../core/tr606';
import { type Params, type Playable, Unit, glide, holdAt } from './unit';

const LOOKAHEAD = 0.1;
const TICK_MS = 25;
/** Note voices this unit sends from NOTE OUT for sequenced hits. */
const SEQ_VOICE = 606_000;

export class Tr606Unit extends Unit implements Playable {
  private s!: Tr606Settings;
  private patterns: Pattern[] = patternsFromText(undefined);
  private chain = [0];
  private bpm = 120;
  private running = false;
  private nextTick = 0;
  private step = 0;
  /** Where in the chain, and the pattern (0–31) playing. */
  private link = 0;
  private playing = 0;
  private queued: { t: number; step: number; pattern: number }[] = [];
  private seqVoice = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly timer: ReturnType<typeof setInterval>;

  private readonly volume = this.ctx.createGain();
  private readonly buses = {} as Record<Sound, GainNode>;
  private readonly noise = this.ctx.createBufferSource();
  private readonly metal: OscillatorNode[] = [];
  private readonly metalSum = this.ctx.createGain();
  private readonly sdNoise = this.ctx.createGain();
  private readonly hatVca = { CH: this.ctx.createGain(), OH: this.ctx.createGain() };
  private readonly cyVca = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;
    this.analyser(this.volume);
    for (const sound of ['BD', 'SD', 'LT', 'HT', 'CY', 'OH', 'CH'] as Sound[]) {
      const g = ctx.createGain();
      g.connect(this.volume);
      this.buses[sound] = g;
    }

    // Noise, for the snare.
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 606;
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    this.noise.buffer = buf;
    this.noise.loop = true;
    const sdHp = ctx.createBiquadFilter();
    sdHp.type = 'highpass';
    sdHp.frequency.value = VOICE.sd.hp;
    this.sdNoise.gain.value = 0;
    this.noise.connect(sdHp).connect(this.sdNoise).connect(this.buses.SD);

    // The metal source: six squares mixed, then filtered two ways.
    this.metalSum.gain.value = 1 / 6;
    for (const f of VOICE.metal) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(this.metalSum);
      this.metal.push(o);
    }
    const path = (bp: number, hp: number, vca: GainNode, to: AudioNode) => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = bp;
      b.Q.value = 1.2;
      const h = ctx.createBiquadFilter();
      h.type = 'highpass';
      h.frequency.value = hp;
      vca.gain.value = 0;
      this.metalSum.connect(b).connect(h).connect(vca).connect(to);
    };
    path(VOICE.ch.bp, VOICE.ch.hp, this.hatVca.CH, this.buses.CH);
    path(VOICE.oh.bp, VOICE.oh.hp, this.hatVca.OH, this.buses.OH);
    path(VOICE.cy.bp, VOICE.cy.hp, this.cyVca, this.buses.CY);

    this.noise.start();
    for (const o of this.metal) o.start();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  set(p: Params) {
    const s = (this.s = tr606Settings(p));
    for (const [sound, g] of Object.entries(this.buses))
      glide(g.gain, s.levels[sound as Sound], this.ctx);
    glide(this.volume.gain, s.volume, this.ctx);
  }

  override setTempo(bpm: number) {
    if (bpm > 0) this.bpm = bpm;
  }

  override setText(text: Record<string, string>) {
    this.patterns = patternsFromText(text);
    this.chain = parseChain(text['chain']);
  }

  override status(): string {
    const now = this.ctx.currentTime;
    while (this.queued.length > 1 && this.queued[1].t <= now) this.queued.shift();
    const head = this.queued[0];
    const on = this.running && head && head.t <= now;
    return encodeStatus(this.running, on ? head.step : -1, on ? head.pattern : -1);
  }

  override command(name: string) {
    if (name === 'run') this.running ? this.stop() : this.start();
    else if (name === 'stop') this.stop();
  }

  // ── Keys ──────────────────────────────────────────────

  /** Each key plays one instrument (see `soundForNote`); a hard one is accented. */
  noteOn(note: number, _step = 0, velocity = 0.8) {
    const sound = soundForNote(note);
    if (sound && this.s) this.hit(sound, this.ctx.currentTime, velocity >= ACCENT_VELOCITY);
  }

  /** Drums are one-shots: lifting the key doesn't stop them. */
  noteOff() {}

  pitchBend() {}

  allNotesOff() {
    const t = this.ctx.currentTime;
    for (const g of [this.sdNoise, this.hatVca.CH, this.hatVca.OH, this.cyVca]) {
      holdAt(g.gain, t);
      g.gain.setTargetAtTime(0, t, 0.005);
    }
  }

  // ── Sequencer ─────────────────────────────────────────

  private start() {
    this.running = true;
    this.step = 0;
    this.link = 0;
    this.playing = patternIndex(this.s?.group ?? 0, this.chain[0]);
    this.nextTick = this.ctx.currentTime + 0.05;
  }

  private stop() {
    this.running = false;
    this.queued = [];
  }

  private schedule() {
    if (!this.running || !this.s) return;
    const now = this.ctx.currentTime;
    if (this.nextTick < now) this.nextTick = now + 0.005;
    while (this.nextTick < now + LOOKAHEAD) this.nextTick += this.tick(this.nextTick);
  }

  /** Plays one step at `t`; returns its length. */
  private tick(t: number): number {
    let pattern = this.patterns[this.playing];
    if (this.step >= pattern.length) {
      // The end of the pattern: on to the next in the chain (a new chain starts at its top).
      this.step = 0;
      this.link = this.link + 1 < this.chain.length ? this.link + 1 : 0;
      this.playing = patternIndex(this.s.group, this.chain[this.link] ?? this.chain[0]);
      pattern = this.patterns[this.playing];
    }
    const i = this.step++;
    this.queued.push({ t, step: i, pattern: this.playing });
    if (this.queued.length > 64) this.queued.shift();
    const len = stepSeconds(this.bpm, pattern.scale);
    const { sounds, accent } = stepHits(pattern.steps[i]);
    // Open and closed hats together: the closed one wins, as it chokes the open.
    for (const sound of sounds) this.hit(sound, t, accent);
    for (const sound of sounds) this.send(SOUND_NOTES[sound], accent, t, len / 2);
    return len;
  }

  // ── Voices ────────────────────────────────────────────

  private hit(sound: Sound, t: number, accent: boolean) {
    const amp = accent ? this.s.accent : 1;
    switch (sound) {
      case 'BD':
        this.knock(VOICE.bd.freqs[0], VOICE.bd.taus[0], VOICE.bd.drop, 0.9 * amp, 'BD', t);
        this.knock(VOICE.bd.freqs[1], VOICE.bd.taus[1], VOICE.bd.drop, 0.25 * amp, 'BD', t);
        break;
      case 'SD':
        this.knock(VOICE.sd.freqs[0], VOICE.sd.taus[0], 0, 0.4 * amp, 'SD', t);
        this.knock(VOICE.sd.freqs[1], VOICE.sd.taus[1], 0, 0.2 * amp, 'SD', t);
        this.gate(this.sdNoise, 0.5 * amp, VOICE.sd.noiseTau, t);
        break;
      case 'LT':
        this.knock(VOICE.lt.freq, VOICE.lt.tau, VOICE.lt.drop, 0.7 * amp, 'LT', t);
        break;
      case 'HT':
        this.knock(VOICE.ht.freq, VOICE.ht.tau, VOICE.ht.drop, 0.7 * amp, 'HT', t);
        break;
      case 'CH':
        this.gate(this.hatVca.OH, 0, 0.004, t); // choke
        this.gate(this.hatVca.CH, 1.4 * amp, VOICE.ch.tau, t);
        break;
      case 'OH':
        this.gate(this.hatVca.OH, 1.2 * amp, openHatTau(this.bpm), t);
        break;
      case 'CY':
        this.gate(this.cyVca, 1.1 * amp, VOICE.cy.tau, t);
        break;
    }
  }

  /** A struck resonator: a sine from rest, its pitch settling down by `drop`, decaying by `tau`. */
  private knock(freq: number, tau: number, drop: number, level: number, bus: Sound, t: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(freq * (1 + drop), t);
    o.frequency.setTargetAtTime(freq, t, 0.012);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.0008);
    g.gain.setTargetAtTime(0, t + 0.0008, tau);
    o.connect(g).connect(this.buses[bus]);
    o.start(t);
    o.stop(t + tau * 8 + 0.01);
    o.onended = () => g.disconnect();
  }

  /** Opens a running source's VCA at `t` and lets it decay by `tau`. */
  private gate(vca: GainNode, level: number, tau: number, t: number) {
    const gain = vca.gain;
    holdAt(gain, t);
    if (level <= 0) {
      gain.setTargetAtTime(0, t, tau);
      return;
    }
    gain.linearRampToValueAtTime(level, t + 0.0008);
    gain.setTargetAtTime(0, t + 0.0008, tau);
  }

  // ── NOTE OUT for sequenced hits ───────────────────────

  private send(note: number, accent: boolean, t: number, length: number) {
    const voice = SEQ_VOICE + this.seqVoice;
    this.seqVoice = (this.seqVoice + 1) % 1000;
    this.later(t, () => this.emit({ type: 'on', voice, note, velocity: accent ? 1 : 0.75 }));
    this.later(t + length, () => this.emit({ type: 'off', voice, note }));
  }

  private later(t: number, fn: () => void) {
    const ms = Math.max(0, (t - this.ctx.currentTime) * 1000);
    if (ms < 1) return fn();
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  override dispose() {
    clearInterval(this.timer);
    for (const id of this.timers) clearTimeout(id);
    this.noise.stop();
    for (const o of this.metal) o.stop();
    super.dispose();
  }
}
