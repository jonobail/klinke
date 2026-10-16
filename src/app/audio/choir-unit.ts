// CHOIR-16 sound: every singer is modelled on the audio thread (public/worklets/choir.js), one
// processor holding all sixteen; this unit decides who sings what and builds the stage:
//
//   notes (keys, MIDI, timeline, NOTE IN) → Allocator (CHOIR / TUTTI / SOLO) → worklet: per singer
//   glottis → vocal tract + nose → stage pan ─ anti-image low-pass ─┬─ dry (close mic) ──┐
//                                                                   ├─ early reflections ─┼─ VOLUME → OUT
//                                                                   └─ hall (convolver) ──┘
//
// The tract runs one section per sample, so its response mirrors above a quarter of the sample
// rate: the low-pass keeps those images out. The worklet module loads asynchronously; until it
// has, messages wait in a queue (OUT exists from the start so cables connect straight away).

import {
  Allocator,
  type ChoirSettings,
  type ChoirStatus,
  GRID,
  MAX_SINGERS,
  MOTIONS,
  type Singer,
  choirSettings,
  choirStatus,
  noseSections,
  singers,
  tractSections,
  velumIndex,
  vowelGrid,
} from '../core/choir';
import { reverbImpulse } from '../core/sound';
import { type NoteEvent, type Params, type Playable, Unit, glide } from './unit';

/** One worklet module load per audio context. */
const modules = new WeakMap<BaseAudioContext, Promise<void>>();

/** The keyboard plays at this velocity (Playable notes carry none). */
const KEY_VELOCITY = 0.75;
/** How the bender bends: ±2 semitones. */
const WHEEL_RANGE = 2;

/** A sounding voice's expression, kept so a legato return to it sounds as it was left. */
interface Voice {
  note: number;
  velocity: number;
  bend: number;
  pressure: number;
  timbre: number;
}

type Message = { type: string } & Record<string, unknown>;

export class ChoirUnit extends Unit implements Playable {
  private s?: ChoirSettings;
  private cast: Singer[] = [];
  private readonly alloc = new Allocator();
  private readonly voices = new Map<number, Voice>();
  private node?: AudioWorkletNode;
  private queue: Message[] | null = [];
  private disposed = false;
  private bodies = '';
  private live: ChoirStatus = { mask: 0, x: 0.5, y: 0.5, level: 0 };

  private readonly lp1 = this.ctx.createBiquadFilter();
  private readonly lp2 = this.ctx.createBiquadFilter();
  private readonly dry = this.ctx.createGain();
  private readonly split = this.ctx.createChannelSplitter(2);
  private readonly merge = this.ctx.createChannelMerger(2);
  private readonly erL = this.ctx.createDelay(0.1);
  private readonly erR = this.ctx.createDelay(0.1);
  private readonly early = this.ctx.createGain();
  private readonly hall = this.ctx.createConvolver();
  private readonly wet = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.output = this.volume;
    for (const lp of [this.lp1, this.lp2]) {
      lp.type = 'lowpass';
      lp.frequency.value = ctx.sampleRate * 0.2;
      lp.Q.value = 0.6;
    }
    this.lp1.connect(this.lp2);
    this.lp2.connect(this.dry).connect(this.volume);
    // Early reflections: the side walls, crossed (left wall heard right, later and duller).
    this.lp2.connect(this.split);
    this.erL.delayTime.value = 0.013;
    this.erR.delayTime.value = 0.019;
    this.split.connect(this.erL, 0).connect(this.merge, 0, 1);
    this.split.connect(this.erR, 1).connect(this.merge, 0, 0);
    this.merge.connect(this.early).connect(this.volume);
    // The hall's tail.
    const ir = reverbImpulse(2.6, ctx.sampleRate, 2, 16);
    const buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
    ir.forEach((ch, i) => buf.copyToChannel(ch, i));
    this.hall.buffer = buf;
    this.lp2.connect(this.hall).connect(this.wet).connect(this.volume);
    this.analyser(this.volume);

    this.post({ type: 'grid', grid: vowelGrid(), size: GRID });
    this.load();
  }

  private async load() {
    const ctx = this.ctx;
    let ready = modules.get(ctx);
    if (!ready) {
      ready = ctx.audioWorklet.addModule(new URL('worklets/choir.js', document.baseURI).href);
      modules.set(ctx, ready);
    }
    try {
      await ready;
    } catch {
      this.queue = null; // no worklet, no voices: stay silent rather than queue forever
      return;
    }
    if (this.disposed) return;
    const node = new AudioWorkletNode(ctx, 'klinke-choir', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => (this.live = e.data as ChoirStatus);
    node.connect(this.lp1);
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
    const s = (this.s = choirSettings(p));
    const ctx = this.ctx;
    this.cast = singers(s, MAX_SINGERS);
    if (prev && (prev.mode !== s.mode || prev.singers !== s.singers)) this.allNotesOff();

    // Bodies: only when they change (a new tract length rebuilds that singer's waveguide).
    const fs = ctx.sampleRate;
    const list = this.cast.map((c) => {
      const n = tractSections(c.length, fs);
      return {
        n,
        m: noseSections(n),
        v: velumIndex(n),
        jaw: c.shape.jaw,
        lips: c.shape.lips,
        pharynx: c.shape.pharynx,
        noseSize: s.noseSize,
        pan: c.pan,
        detune: c.detune,
        vibRate: c.vibRate,
        vibDepth: c.vibDepth,
        breath: c.breath,
        jitter: c.jitter,
        tense: c.tense,
        lag: c.lag,
      };
    });
    const key = JSON.stringify(list);
    if (key !== this.bodies) {
      this.bodies = key;
      this.post({ type: 'singers', list });
    }

    this.post({
      type: 'params',
      params: {
        vowelX: s.vowelX,
        vowelY: s.vowelY,
        motion: MOTIONS.indexOf(s.motion),
        motionRate: s.motionRate,
        motionDepth: s.motionDepth,
        tense: s.tense,
        breath: s.breath,
        rasp: s.rasp,
        vibDepth: s.vibDepth,
        vibRate: s.vibRate,
        vibDelay: s.vibDelay,
        scoop: s.scoop,
        scoopTime: s.scoopTime,
        drift: s.drift,
        attack: s.attack,
        release: s.release,
        legato: s.legato,
        velum: s.velum,
        width: s.width,
      },
    });

    // ROOM is how far back the microphones stand: closer is drier, further is more hall.
    glide(this.dry.gain, 1 - 0.6 * s.room, ctx);
    glide(this.early.gain, 0.15 + 0.45 * s.room, ctx);
    glide(this.wet.gain, 0.05 + 0.9 * s.room * s.room, ctx);
    glide(this.volume.gain, s.volume * 5, ctx);
  }

  // ── Notes ─────────────────────────────────────────────
  // Keyboard voices and NOTE IN voices live in separate id spaces (odd and even), so a key and a
  // cable voice with the same number never collide.

  noteOn(note: number) {
    this.start(note * 2 + 1, note, KEY_VELOCITY, 0, KEY_VELOCITY, 0.5);
  }

  noteOff(note: number) {
    this.end(note * 2 + 1);
  }

  allNotesOff() {
    this.voices.clear();
    this.alloc.reset();
    this.post({ type: 'allOff' });
  }

  pitchBend(amount: number) {
    this.post({ type: 'params', params: { wheel: amount * WHEEL_RANGE } });
  }

  override receive(jack: string, e: NoteEvent) {
    if (jack !== 'notesIn') return;
    const id = e.voice * 2;
    if (e.type === 'on') {
      const vel = e.velocity ?? 0.8;
      this.start(id, e.note, vel, e.bend ?? 0, e.pressure ?? vel, e.timbre ?? 0.5);
    } else if (e.type === 'off') {
      this.end(id);
    } else {
      const v = this.voices.get(id);
      if (!v) return;
      if (e.bend !== undefined) v.bend = e.bend;
      if (e.pressure !== undefined) v.pressure = e.pressure;
      if (e.timbre !== undefined) v.timbre = e.timbre;
      for (const s of this.alloc.singersOf(id))
        this.post({ type: 'expr', s, bend: e.bend, pressure: e.pressure, timbre: e.timbre });
    }
  }

  private start(
    id: number,
    note: number,
    velocity: number,
    bend: number,
    pressure: number,
    timbre: number,
  ) {
    const s = this.s;
    if (!s) return;
    if (this.voices.has(id)) this.end(id);
    const v: Voice = { note, velocity, bend, pressure, timbre };
    this.voices.set(id, v);
    const cast = this.cast.slice(0, s.singers);
    this.sing(this.alloc.on(id, note, s.mode, cast, s.legato > 0), v);
  }

  private end(id: number) {
    const s = this.s;
    if (!s || !this.voices.delete(id)) return;
    const cast = this.cast.slice(0, s.singers);
    const { release, back } = this.alloc.off(id, s.mode, cast, s.legato > 0);
    for (const singer of release) this.post({ type: 'off', s: singer });
    const prev = back.length ? this.voices.get(back[0].voice) : undefined;
    if (prev) this.sing(back, prev);
  }

  private sing(assignments: ReturnType<Allocator['on']>, v: Voice) {
    for (const a of assignments) {
      this.post({
        type: 'on',
        s: a.singer,
        note: a.note,
        vel: v.velocity,
        pressure: v.pressure,
        timbre: v.timbre,
        legato: a.legato,
      });
      if (v.bend) this.post({ type: 'expr', s: a.singer, bend: v.bend });
    }
  }

  override status(): string {
    return choirStatus(this.live);
  }

  override dispose() {
    this.disposed = true;
    this.post({ type: 'stop' });
    this.node?.port.close();
    this.node?.disconnect();
    for (const n of [
      this.lp1,
      this.lp2,
      this.dry,
      this.split,
      this.merge,
      this.erL,
      this.erR,
      this.early,
      this.hall,
      this.wet,
    ])
      n.disconnect();
    super.dispose();
  }
}
