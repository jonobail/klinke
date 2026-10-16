// JUPITER-8 sound, after the service notes' functional and block diagrams (pp.6–7):
//
//   keys / NOTE IN ─ HOLD ─┬──────────────────────────┐
//                          └ ARPEGGIO (clock: INT rate or the song tempo) ┴→ ASSIGNER (SOLO /
//   UNISON / POLY 1 / POLY 2) → eight voices on the audio thread → VOLUME → OUT
//
// The voices (two VCOs with cross mod and sync, source mix, HPF, 12 / 24 dB VCF, VCA, two
// envelopes, the shared LFO and noise) run as one AudioWorklet: `Jupiter8Dsp` from core, sent
// to the audio thread as source text, so the maths stays testable in Node. Eight voices of
// polyBLEP oscillators and ladder filters cost far less there than a graph of native nodes, and
// hard sync and audio-rate cross mod need per-sample oscillators anyway. This unit is the CPU:
// it assigns keys to voices, runs the arpeggio and sends time-stamped gate events.

import {
  type ArpMode,
  type DspEvent,
  Jp8Assigner,
  Jupiter8Dsp,
  type Jupiter8Settings,
  type VoiceAction,
  arpPeriod,
  arpeggio,
  dspParams,
  jupiter8Settings,
} from '../core/jupiter8';
import { type Params, type Playable, Unit, glide } from './unit';

/** How far ahead the arpeggio schedules (s) and how often it wakes up (ms). */
const LOOKAHEAD = 0.1;
const TICK_MS = 25;

/** One worklet module per audio context, built from the DSP class's source. */
const modules = new WeakMap<BaseAudioContext, Promise<void>>();

function moduleUrl(): string {
  const src = `const Dsp = (${Jupiter8Dsp.toString()});
registerProcessor('klinke-jupiter8', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new Dsp(sampleRate);
    this.port.onmessage = (e) => this.dsp.message(e.data);
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    this.dsp.render(out[0], currentTime);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    return true;
  }
});`;
  return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}

type Message = { type: string } & Record<string, unknown>;

export class Jupiter8Unit extends Unit implements Playable {
  private s?: Jupiter8Settings;
  private readonly assigner = new Jp8Assigner();
  private node?: AudioWorkletNode;
  private queue: Message[] | null = [];
  private disposed = false;
  private readonly volume = this.ctx.createGain();
  private readonly timer: ReturnType<typeof setInterval>;

  /** Keys physically down, oldest first. */
  private down: number[] = [];
  /** Notes HOLD keeps sounding (or the latched arpeggio chord). */
  private latched: number[] = [];
  private bpm = 120;
  private nextTick = 0;
  private step = 0;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;
    this.volume.gain.value = 1;
    this.load();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  private async load() {
    const ctx = this.ctx;
    let ready = modules.get(ctx);
    if (!ready) {
      ready = ctx.audioWorklet.addModule(moduleUrl());
      modules.set(ctx, ready);
    }
    try {
      await ready;
    } catch {
      this.queue = null; // no worklet, no voices: stay silent rather than queue forever
      return;
    }
    if (this.disposed) return;
    const node = new AudioWorkletNode(ctx, 'klinke-jupiter8', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.connect(this.volume);
    this.node = node;
    for (const m of this.queue ?? []) node.port.postMessage(m);
    this.queue = [];
  }

  private post(m: Message) {
    if (this.node) this.node.port.postMessage(m);
    else this.queue?.push(m);
  }

  set(p: Params) {
    const prev = this.s;
    const s = (this.s = jupiter8Settings(p));
    this.post({ type: 'params', params: dspParams(s) });
    glide(this.volume.gain, 1, this.ctx);

    const t = this.ctx.currentTime;
    this.send(this.assigner.setMode(s.assign), t);
    if (!prev) return;
    // Switching the arpeggio on or off starts the keys over.
    if ((prev.arp === 'off') !== (s.arp === 'off')) {
      this.stopArp();
      this.send(this.assigner.releaseAll(), t);
      if (s.arp === 'off') for (const n of this.down) this.send(this.assigner.press(n), t);
    }
    // HOLD off lets go of whatever only it was keeping.
    if (prev.hold && !s.hold) {
      for (const n of this.latched)
        if (!this.down.includes(n) && s.arp === 'off') this.release(n, t);
      this.latched = [];
      if (s.arp !== 'off' && !this.down.length) this.stopArp();
    }
  }

  override setTempo(bpm: number) {
    this.bpm = bpm;
  }

  // ── Keys ──────────────────────────────────────────────

  noteOn(note: number) {
    const s = this.s;
    if (!s) return;
    const t = this.ctx.currentTime;
    // With HOLD on, a fresh arpeggio chord replaces the latched one.
    if (s.hold && s.arp !== 'off' && !this.down.length) this.latched = [];
    this.down = [...this.down.filter((n) => n !== note), note];
    if (s.hold) this.latched = [...new Set([...this.latched, note])];
    if (s.arp !== 'off') return; // the arpeggio clock plays it
    this.send(this.assigner.press(note), t);
  }

  noteOff(note: number) {
    const s = this.s;
    if (!s) return;
    const t = this.ctx.currentTime;
    this.down = this.down.filter((n) => n !== note);
    if (s.arp !== 'off') {
      if (!this.down.length && !s.hold) this.stopArp();
      return;
    }
    if (!s.hold) this.release(note, t);
  }

  allNotesOff() {
    const t = this.ctx.currentTime;
    this.down = [];
    this.latched = [];
    this.assigner.releaseAll();
    this.post({ type: 'allOff', time: t });
  }

  pitchBend(amount: number) {
    this.post({ type: 'bend', value: amount });
  }

  /** The bender lever pushed forward: LFO MODULATION on while it's held. */
  override command(name: string) {
    if (name === 'modOn' || name === 'modOff') this.post({ type: 'push', on: name === 'modOn' });
  }

  private release(note: number, t: number) {
    this.send(this.assigner.release(note), t);
  }

  /** Assigner actions → time-stamped gate events for the voices. */
  private send(actions: VoiceAction[], time: number) {
    for (const a of actions) {
      const e: DspEvent =
        a.type === 'on'
          ? { type: 'on', time, voice: a.voice, note: a.note, retrigger: a.retrigger }
          : { type: 'off', time, voice: a.voice };
      this.post(e);
    }
  }

  // ── Arpeggio ──────────────────────────────────────────

  /** The arpeggio's last step lets go by itself (its release is already scheduled). */
  private stopArp() {
    this.step = 0;
    this.nextTick = 0;
  }

  private schedule() {
    const s = this.s;
    if (!s || s.arp === 'off') return;
    const now = this.ctx.currentTime;
    const keys = this.down.length ? this.down : s.hold ? this.latched : [];
    if (!keys.length) {
      this.nextTick = 0;
      return;
    }
    if (this.nextTick < now) this.nextTick = now + 0.005;
    while (this.nextTick < now + LOOKAHEAD) {
      const period = arpPeriod(s, this.bpm);
      this.tick(this.nextTick, period, keys, s.arp, s.arpRange);
      this.nextTick += period;
    }
  }

  private tick(t: number, period: number, keys: number[], mode: ArpMode, range: number) {
    const order = arpeggio(keys, mode, range);
    if (!order.length) return;
    const note =
      mode === 'random'
        ? order[Math.floor(Math.random() * order.length)]
        : order[this.step++ % order.length];
    // Each step is a key pressed for half the step and let go (through the assign mode).
    this.send(this.assigner.press(note), t);
    this.send(this.assigner.release(note), t + period * 0.5);
  }

  override status(): string | null {
    const s = this.s;
    if (!s) return null;
    const mode = { solo: 'SOLO', unison: 'UNISON', poly1: 'POLY 1', poly2: 'POLY 2' }[s.assign];
    return `${mode} · ${this.assigner.busy}/8`;
  }

  override dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.node?.disconnect();
    this.node?.port.close();
    super.dispose();
  }
}
