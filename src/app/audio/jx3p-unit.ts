// JX-3P sound, after the service notes' block diagram (p.4):
//
//   KEYS / SEQUENCER → CPU (assigner, ADSR ×6, LFO) ─┐
//   SYNTHESIZER MODULE ×6: DCO-1 ┬ MIXER (BAL) → 4-pole VCF → VCA ─┴→ MIXER → HPF → STEREO CHORUS → OUT
//                          DCO-2 ┘ (SYNC / METAL, NOISE)
//
// The six voices with their envelopes and the LFO run in an AudioWorklet (`Jx3pVoices` in
// core/jx3p.ts, loaded from its own source text so it stays one tested piece of code); the shared
// HPF, the chorus and the volume are Web Audio nodes. Keys, the sequencer and the panel post
// timed events to the worklet, which applies them on the exact sample.

import {
  type Jx3pSettings,
  Jx3pVoices,
  SEQ_ID,
  type SeqStep,
  type VoiceEvent,
  type VoiceSettings,
  addStep,
  jx3pSettings,
  sequenceChunks,
  sequenceFromText,
  stepAt,
} from '../core/jx3p';
import { type Params, type Playable, Unit, glide } from './unit';

const LOOKAHEAD = 0.1;
const TICK_MS = 25;

/** The worklet: the voices' class, then a processor that plays timed events into it. */
const PROCESSOR = `
const Voices = (${Jx3pVoices.toString()});
class Jx3pProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = new Voices(sampleRate);
    this.queue = [];
    this.blocks = 0;
    this.port.onmessage = (m) => {
      for (const e of m.data) {
        if (e.type === 'seqStop') this.queue = this.queue.filter((q) => !q.seq);
        const at = e.t || 0;
        let i = this.queue.length;
        while (i > 0 && (this.queue[i - 1].t || 0) > at) i--;
        this.queue.splice(i, 0, e);
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    const end = out.length;
    const t0 = currentTime;
    let start = 0;
    while (this.queue.length && (this.queue[0].t || 0) < t0 + end / sampleRate) {
      const e = this.queue.shift();
      const at = Math.max(start, Math.min(end, Math.round(((e.t || 0) - t0) * sampleRate)));
      if (at > start) this.voices.render(out, start, at);
      start = at;
      this.voices.handle(e);
    }
    this.voices.render(out, start, end);
    if (++this.blocks % 16 === 0) this.port.postMessage(this.voices.active());
    return true;
  }
}
registerProcessor('klinke-jx3p', Jx3pProcessor);
`;

/** One module load per audio context. */
const modules = new WeakMap<BaseAudioContext, Promise<void>>();

type TimedEvent = VoiceEvent & { t?: number; seq?: boolean };

export class Jx3pUnit extends Unit implements Playable {
  private s!: Jx3pSettings;
  private node?: AudioWorkletNode;
  private queue: TimedEvent[] | null = [];
  private disposed = false;
  private sounding = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  // Keys
  private readonly down = new Set<number>();
  /** Keys let go while HOLD is on, still sounding. */
  private readonly latched = new Set<number>();
  // Sequencer
  private sequence: SeqStep[] = [];
  /** The chord being keyed in while writing: a step once every key is up. */
  private pending: number[] = [];
  private transpose = 0;
  private bpm = 120;
  private step = 0;
  private nextStep = 0;
  private playing = false;

  // Shared after the voices: HPF, chorus, volume
  private readonly hpf = this.ctx.createBiquadFilter();
  private readonly dry = this.ctx.createGain();
  private readonly preBbd = this.ctx.createBiquadFilter();
  private readonly bbds = [this.ctx.createDelay(0.02), this.ctx.createDelay(0.02)];
  private readonly postBbd = [this.ctx.createBiquadFilter(), this.ctx.createBiquadFilter()];
  private readonly wet = [this.ctx.createGain(), this.ctx.createGain()];
  private readonly sweep = this.ctx.createOscillator();
  private readonly sweepDepth = [this.ctx.createGain(), this.ctx.createGain()];
  private readonly merge = this.ctx.createChannelMerger(2);
  private readonly volume = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;

    // HPF after the six voices are mixed (block diagram): non-resonant, 12 dB.
    this.hpf.type = 'highpass';
    this.hpf.Q.value = -3.01;
    this.hpf.frequency.value = 5;
    // Stereo chorus (p.7): two BBDs swept by one triangle, 180° apart, each with 10 kHz
    // filters before and after; dry plus one BBD on each side.
    this.preBbd.type = 'lowpass';
    this.preBbd.frequency.value = 10000;
    this.hpf.connect(this.dry);
    this.hpf.connect(this.preBbd);
    this.sweep.type = 'triangle';
    this.sweep.frequency.value = 0.65;
    this.bbds.forEach((d, i) => {
      // 256 stages clocked at 40–200 kHz is 0.64–3.2 ms; the sweep spans most of it.
      d.delayTime.value = 0.0019;
      this.sweepDepth[i].gain.value = i ? -0.0011 : 0.0011;
      this.sweep.connect(this.sweepDepth[i]).connect(d.delayTime);
      this.postBbd[i].type = 'lowpass';
      this.postBbd[i].frequency.value = 10000;
      this.preBbd
        .connect(d)
        .connect(this.postBbd[i])
        .connect(this.wet[i])
        .connect(this.merge, 0, i);
      this.dry.connect(this.merge, 0, i);
    });
    this.merge.connect(this.volume);
    this.sweep.start();

    this.load();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  private async load() {
    const ctx = this.ctx;
    let ready = modules.get(ctx);
    if (!ready) {
      const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }));
      ready = ctx.audioWorklet.addModule(url);
      modules.set(ctx, ready);
    }
    try {
      await ready;
    } catch {
      this.queue = null; // no worklet, no voices
      return;
    }
    if (this.disposed) return;
    const node = new AudioWorkletNode(ctx, 'klinke-jx3p', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (e) => (this.sounding = e.data as number);
    node.connect(this.hpf);
    this.node = node;
    if (this.queue?.length) node.port.postMessage(this.queue);
    this.queue = [];
  }

  private post(...events: TimedEvent[]) {
    if (this.node) this.node.port.postMessage(events);
    else this.queue?.push(...events);
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = jx3pSettings(p));
    const ctx = this.ctx;
    const voice: VoiceSettings = {
      dco1Ratio: s.dco1Ratio,
      dco1Wave: s.dco1Wave,
      dco1Lfo: s.dco1Lfo,
      dco1Env: s.dco1Env,
      dco2Ratio: s.dco2Ratio,
      dco2Wave: s.dco2Wave,
      crossMod: s.crossMod,
      dco2Semis: s.dco2Semis,
      dco2Fine: s.dco2Fine,
      dco2Lfo: s.dco2Lfo,
      dco2Env: s.dco2Env,
      lfoDepth: s.lfoDepth,
      envDepth: s.envDepth,
      mix: s.mix,
      cutoff: s.cutoff,
      resonance: s.resonance,
      vcfLfo: s.vcfLfo,
      vcfEnv: s.vcfEnv,
      pitchFollow: s.pitchFollow,
      vcaGate: s.vcaGate,
      vcaLevel: s.vcaLevel,
      lfoWave: s.lfoWave,
      lfoDelay: s.lfoDelay,
      lfoRate: s.lfoRate,
      attack: s.attack,
      decay: s.decay,
      sustain: s.sustain,
      release: s.release,
      brilliance: s.brilliance,
      mute: s.mute,
      bendRange: s.bendRange,
    };
    this.post({ type: 'params', settings: voice });

    glide(this.hpf.frequency, s.hpf, ctx);
    glide(this.dry.gain, s.chorus ? 0.75 : 1, ctx);
    for (const w of this.wet) glide(w.gain, s.chorus ? 0.75 : 0, ctx);
    glide(this.volume.gain, s.volume, ctx);

    // HOLD off lets go of the keys no longer down.
    if (prev?.hold && !s.hold) {
      for (const id of this.latched) if (!this.down.has(id)) this.post({ type: 'off', id });
      this.latched.clear();
    }
    // WRITE starts a new sequence (and nothing plays while writing).
    if (s.seqWrite && !prev?.seqWrite) {
      this.pending = [];
      if (prev) this.saveSequence([]);
    }
    const play = s.seqPlay && !s.seqWrite;
    if (play && !this.playing) {
      this.step = 0;
      this.nextStep = 0;
    } else if (!play && this.playing) this.post({ type: 'seqStop' });
    this.playing = play;
  }

  /** The stored sequence comes back from the patch (the hardware keeps it on battery). */
  override setText(text: Record<string, string>) {
    this.sequence = sequenceFromText(text);
  }

  override setTempo(bpm: number) {
    this.bpm = bpm;
  }

  private saveSequence(seq: SeqStep[]) {
    this.sequence = seq;
    for (const [k, v] of Object.entries(sequenceChunks(seq))) this.saveText?.(k, v);
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number) {
    const s = this.s;
    // KEY TRANSPOSE while the sequencer plays: the key moves the line (from C4) and doesn't sound.
    if (s.keyTranspose && this.playing) {
      this.transpose = note - 60;
      return;
    }
    this.down.add(note);
    this.latched.delete(note);
    if (s.seqWrite && this.pending.length < 6 && !this.pending.includes(note))
      this.pending.push(note);
    this.post({ type: 'on', id: note, note });
  }

  noteOff(note: number) {
    const s = this.s;
    if (!this.down.delete(note)) return;
    if (s.hold) this.latched.add(note);
    else this.post({ type: 'off', id: note });
    // The chord is one step once every key is up.
    if (s.seqWrite && !this.down.size && this.pending.length) {
      this.saveSequence(
        addStep(
          this.sequence,
          [...this.pending].sort((a, b) => a - b),
        ),
      );
      this.pending = [];
    }
  }

  allNotesOff() {
    this.down.clear();
    this.latched.clear();
    this.pending = [];
    this.post({ type: 'all' });
  }

  pitchBend(amount: number) {
    this.post({ type: 'bend', value: amount });
  }

  override command(name: string) {
    if (name === 'lfoTrig') this.post({ type: 'lfoTrig' });
    if (!this.s.seqWrite) return;
    if (name === 'tie' && this.sequence.length) this.saveSequence(addStep(this.sequence, 'tie'));
    if (name === 'rest') this.saveSequence(addStep(this.sequence, []));
  }

  // ── Sequencer clock ───────────────────────────────────

  private schedule() {
    if (!this.playing || !this.sequence.length) return;
    const now = this.ctx.currentTime;
    const len = (60 / this.bpm) * this.s.seqRate;
    if (this.nextStep < now) this.nextStep = now + 0.01;
    while (this.nextStep < now + LOOKAHEAD) {
      const i = this.step % this.sequence.length;
      const { notes, steps } = stepAt(this.sequence, i, this.transpose);
      const t = this.nextStep;
      // Each note sounds for its steps less half a step (ties run on into the next steps).
      const off = t + (steps - 0.5) * len;
      for (const n of notes) {
        if (n < 0 || n > 127) continue;
        this.post(
          { type: 'on', id: SEQ_ID + n, note: n, t, seq: true },
          { type: 'off', id: SEQ_ID + n, t: off, seq: true },
        );
      }
      this.step = i + 1;
      this.nextStep += len;
    }
  }

  /** For the panel: voices sounding, steps stored, the step playing, writing. */
  override status(): string | null {
    return JSON.stringify({
      voices: this.sounding,
      steps: this.sequence.length,
      at: this.playing && this.sequence.length ? this.step % this.sequence.length : -1,
    });
  }

  override dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.sweep.stop();
    this.node?.disconnect();
    this.node?.port.close();
    super.dispose();
  }
}
