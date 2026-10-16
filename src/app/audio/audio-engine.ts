import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GEAR, type GearKind, jackDef } from '../core/gear';
import { type Cable, type Patch } from '../core/patch';
import { BASE_MAX, BASE_MIN, noteName, parseMidi, shiftBase } from '../core/sound';
import { PatchStore } from '../patch-store';
import { Transport } from '../transport';
import { type NoteEvent, type Playable, type Unit, isPlayable } from './unit';
import { createUnit } from './units';

/** A note played by hand on a piece of gear: on (true) or off. */
export type NoteListener = (gearId: string, note: number, on: boolean) => void;

export type MidiStatus = 'off' | 'unsupported' | 'insecure' | 'denied' | 'ready';

/**
 * Gear you play notes into: the synths, and the note effects (CHORD-8, MOTION-15) that turn
 * them into more notes on their NOTE OUT jacks.
 */
export const playsNotes = (kind: GearKind) =>
  GEAR[kind].category === 'synth' || GEAR[kind].category === 'midi';

/**
 * A live NOTE cable: where its events go, and the voices it has started but not yet stopped,
 * so unplugging it can stop them instead of leaving them hanging.
 */
interface NoteLine {
  key: string;
  from: Unit;
  fromJack: string;
  to: Unit;
  toId: string;
  jack: string;
  /** Sounding voice → its note. */
  open: Map<number, number>;
}

/** Velocity of notes from the keys, MIDI and tracks as they leave an instrument's NOTE OUT. */
const KEY_VELOCITY = 0.8;
/** The NOTE OUT jack on every instrument. */
const NOTE_OUT = 'notesOut';

const isNoteCable = (patch: Patch, c: Cable) => {
  const kind = patch.gear.find((g) => g.id === c.from.gear)?.kind;
  return !!kind && jackDef(kind, c.from.jack)?.signal === 'note';
};

/**
 * Turns the patch into sound. Each piece of gear gets a Web Audio unit; cables become node
 * connections. The graph follows the patch: gear and cables are diffed, knob moves only touch
 * the params of the gear that changed.
 */
@Injectable({ providedIn: 'root' })
export class AudioEngine {
  private readonly store = inject(PatchStore);
  private readonly transport = inject(Transport);
  private ctx?: AudioContext;
  private readonly units = new Map<string, Unit>();
  private readonly lastParams = new Map<string, Record<string, number>>();
  private readonly lastText = new Map<string, Record<string, string> | undefined>();
  private wiring = '';
  /** The AUDIO button's deliberate mute (it stays until pressed again). */
  readonly muted = signal(false);
  /**
   * Set when the current gesture woke the audio, so that same press on the AUDIO button doesn't
   * mute it again; cleared when the gesture ends (see `endGesture`).
   */
  private justWoke = false;
  private unlocked = false;
  private silentLoop?: HTMLAudioElement;
  /** Which synth each sounding note went to, so note-off finds it after the selection moves. */
  private readonly sounding = new Map<string, string>();

  readonly running = signal(false);
  /** Live display text per gear id, for units that report one (see `Unit.status`). */
  readonly statuses = signal<Record<string, string>>({});
  /** Meter readings per gear id (mixer: 4 channels + main; output: 1). */
  readonly levels = signal<Record<string, number[]>>({});
  /** Notes held per synth id, for lighting the keys. */
  readonly held = signal<Record<string, number[]>>({});
  /** MIDI note of the lowest C on the computer keyboard and on the synth's keys. */
  readonly base = signal(48);
  readonly midi = signal<MidiStatus>('off');
  readonly midiInputs = signal<string[]>([]);

  constructor() {
    effect(() => {
      const patch = this.store.patch();
      if (this.ctx) this.sync(patch);
    });
    // Selecting a synth hands it the keyboard, and it keeps it after the selection clears.
    effect(() => {
      const id = this.store.selected();
      const gear = this.store.patch().gear.find((g) => g.id === id);
      if (gear && playsNotes(gear.kind)) this.lastSynth.set(gear.id);
    });
    // Every unit keeps the song tempo (arpeggios, tempo-synced movement).
    effect(() => {
      const bpm = this.transport.bpm();
      for (const u of this.units.values()) u.setTempo(bpm);
    });
  }

  /**
   * Call from inside a user gesture (tap, click, key). Creates or resumes the audio, and does the
   * extra steps iOS needs: resume inside the gesture, play a silent sample once, and ask for
   * media playback so the ringer / silent switch doesn't mute the page.
   */
  unlock() {
    const wasRunning = this.ctx?.state === 'running';
    this.start();
    const ctx = this.ctx!;
    if (!this.unlocked) {
      const blip = ctx.createBufferSource();
      blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      blip.connect(ctx.destination);
      blip.start();
      this.unlocked = true;
    }
    this.playbackSession();
    if (!wasRunning && !this.muted()) this.justWoke = true;
  }

  /**
   * iOS plays web audio on the ringer channel, which the silent switch mutes. Newer WebKit lets a
   * page ask for the playback channel directly; older iOS needs an HTML audio element playing (a
   * silent loop) to switch the whole page to it.
   */
  private playbackSession() {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        if (session.type !== 'playback') session.type = 'playback';
      } catch {
        // read-only or unsupported here; fall through to nothing
      }
      return;
    }
    const iOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!iOS || this.silentLoop) return;
    const a = new Audio(silentWav());
    a.loop = true;
    a.setAttribute('playsinline', '');
    void a.play().catch(() => (this.silentLoop = undefined));
    this.silentLoop = a;
  }

  /** The gesture is over (its click or key-up has been handled everywhere). */
  endGesture() {
    this.justWoke = false;
  }

  /** Starts (or resumes) audio. Browsers only allow this from a click or key press. */
  start() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx.onstatechange = () => this.running.set(this.ctx?.state === 'running');
      this.running.set(this.ctx.state === 'running');
      this.sync(this.store.patch());
      this.meterLoop();
      void this.connectMidi();
    }
    // 'suspended' before a gesture, or 'interrupted' on iOS after a call / switching apps.
    if (!this.muted() && this.ctx.state !== 'running') void this.ctx.resume();
  }

  /** The AUDIO button: mutes by suspending the audio clock, and stays muted until pressed again. */
  toggle() {
    // The press that just woke the audio (via unlock) shouldn't also mute it.
    if (this.justWoke) {
      this.justWoke = false;
      this.muted.set(false);
      return;
    }
    this.muted.set(!this.muted() && this.running());
    if (this.muted()) {
      this.allNotesOff();
      void this.ctx?.suspend();
    } else this.start();
  }

  // ── Notes ─────────────────────────────────────────────

  /**
   * The gear the computer keyboard and MIDI play (a synth or a note effect, see `playsNotes`):
   * the selected one, else the last one selected or played, else the first on the floor.
   */
  readonly keyboardSynth = computed(() => {
    const synths = this.store.patch().gear.filter((g) => playsNotes(g.kind));
    const pick = (id: string | null) => synths.find((g) => g.id === id)?.id;
    return pick(this.store.selected()) ?? pick(this.lastSynth()) ?? synths[0]?.id ?? null;
  });
  private readonly lastSynth = signal<string | null>(null);
  /** Pitch-wheel position per synth, -1…+1, for drawing the wheel. */
  readonly bends = signal<Record<string, number>>({});

  private target(only?: string): string | null {
    return only ?? this.keyboardSynth();
  }

  /** Neither synth senses velocity, so MIDI velocity is ignored. */
  /**
   * Plays a note. `fromTrack` marks notes played back from a MIDI track: they don't take the
   * keyboard, aren't reported to note listeners (so they aren't recorded again) and are tracked
   * apart from the same key held by hand.
   */
  noteOn(note: number, only?: string, fromTrack = false) {
    this.start();
    const id = this.target(only);
    if (!id) return;
    if (!fromTrack) this.lastSynth.set(id);
    const key = `${fromTrack ? 'track:' : ''}${only ?? '*'}:${note}`;
    if (this.sounding.has(key)) this.noteOff(note, only, fromTrack);
    this.sounding.set(key, id);
    const unit = this.units.get(id);
    if (isPlayable(unit)) unit.noteOn(note, note - this.base());
    this.hold(id, note, true);
    this.thru(id, `key:${key}`, { type: 'on', voice: 0, note, velocity: KEY_VELOCITY });
    if (!fromTrack) for (const l of this.listeners) l(id, note, true);
  }

  noteOff(note: number, only?: string, fromTrack = false) {
    const key = `${fromTrack ? 'track:' : ''}${only ?? '*'}:${note}`;
    const id = this.sounding.get(key);
    if (!id) return;
    this.sounding.delete(key);
    const unit = this.units.get(id);
    if (isPlayable(unit)) unit.noteOff(note);
    this.hold(id, note, false);
    this.thru(id, `key:${key}`, { type: 'off', voice: 0, note });
    if (!fromTrack) for (const l of this.listeners) l(id, note, false);
  }

  private readonly listeners = new Set<NoteListener>();

  /** Hears every note played by hand (keys, MIDI, on-screen); returns an unsubscribe. */
  listen(fn: NoteListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  allNotesOff() {
    for (const u of this.units.values()) if (isPlayable(u)) u.allNotesOff();
    // Anything a note effect still holds open down a NOTE cable stops too.
    for (const line of this.noteLines.values()) this.release(line);
    this.sounding.clear();
    this.cableNotes.clear();
    this.thruVoices.clear();
    this.held.set({});
  }

  /** Pitch wheel or MIDI pitch bend, -1…+1. */
  pitchBend(amount: number, only?: string) {
    const id = this.target(only);
    if (!id) return;
    const unit = this.units.get(id);
    if (isPlayable(unit)) unit.pitchBend(amount);
    this.bends.update((b) => ({ ...b, [id]: amount }));
    // The wheel bends the notes played on the keys as they leave NOTE OUT (±2 semitones).
    for (const [source, voice] of this.thruVoices.get(id) ?? []) {
      if (source.startsWith('key:'))
        this.emitThru(id, { type: 'expr', voice, note: 0, bend: amount * 2 });
    }
  }

  /** A front-panel action on one piece of gear (see `Unit.command`). */
  command(gearId: string, name: string) {
    this.start();
    this.units.get(gearId)?.command(name);
  }

  /** MIDI mod wheel (CC 1) moves the mod wheel of synths that have one. */
  private modWheel(value: number) {
    const id = this.keyboardSynth();
    const gear = id && this.store.patch().gear.find((g) => g.id === id);
    if (gear && 'modWheel' in gear.params) this.store.setParam(gear.id, 'modWheel', value);
  }

  shiftOctave(by: number) {
    this.allNotesOff();
    this.base.update((b) => shiftBase(b, by));
    const b = this.base();
    this.store.flash(
      `keyboard from ${noteName(b)}${b === BASE_MIN || b === BASE_MAX ? ' (end of range)' : ''}`,
    );
  }

  // ── Graph sync ────────────────────────────────────────

  private sync(patch: Patch) {
    const ctx = this.ctx!;
    const ids = new Set(patch.gear.map((g) => g.id));
    for (const [id, unit] of this.units) {
      if (ids.has(id)) continue;
      unit.dispose();
      for (const jack of Object.keys(unit.noteOuts)) unit.noteOuts[jack] = undefined;
      this.units.delete(id);
      this.cableNotes.delete(unit);
      this.thruVoices.delete(id);
      this.lastParams.delete(id);
      this.lastText.delete(id);
    }
    let added = false;
    for (const g of patch.gear) {
      let unit = this.units.get(g.id);
      if (!unit) {
        unit = createUnit(g.kind, ctx);
        const id = g.id;
        unit.saveText = (key, value) => this.store.setText(id, key, value);
        unit.setTempo(untracked(this.transport.bpm));
        this.units.set(g.id, unit);
        added = true;
      }
      if (this.lastText.get(g.id) !== g.text) {
        unit.setText(g.text ?? {});
        this.lastText.set(g.id, g.text);
      }
      if (this.lastParams.get(g.id) !== g.params) {
        unit.set(g.params);
        this.lastParams.set(g.id, g.params);
      }
    }
    const wiring = patch.cables
      .map((c) => `${c.from.gear}.${c.from.jack}>${c.to.gear}.${c.to.jack}`)
      .join();
    if (wiring === this.wiring && !added) return;
    this.wiring = wiring;
    for (const unit of this.units.values()) unit.unplugOutputs();
    for (const c of patch.cables) {
      if (isNoteCable(patch, c)) continue;
      const from = this.units.get(c.from.gear)?.outputFor(c.from.jack);
      const to = this.units.get(c.to.gear)?.inputs[c.to.jack];
      if (from && to) from.connect(to);
    }
    this.wireNotes(patch);
    // Re-patching unplugged everything leaving each OUT jack, recording taps included.
    for (const [node, source] of this.captures) this.sourceNode(source)?.connect(node);
    this.connectTrackBus();
  }

  // ── NOTE cables ───────────────────────────────────────

  /** Live NOTE cables, keyed by their two jacks (so replugging the same pair keeps its voices). */
  private readonly noteLines = new Map<string, NoteLine>();

  /**
   * Points every NOTE OUT jack at the unit its cable plugs into. Cables that are gone first stop
   * the voices they left sounding downstream; jacks with no cable are cleared.
   */
  private wireNotes(patch: Patch) {
    const lines = new Map<string, NoteLine>();
    for (const c of patch.cables) {
      if (!isNoteCable(patch, c)) continue;
      const from = this.units.get(c.from.gear);
      const to = this.units.get(c.to.gear);
      if (!from || !to) continue;
      const key = `${c.from.gear}.${c.from.jack}>${c.to.gear}.${c.to.jack}`;
      const old = this.noteLines.get(key);
      lines.set(
        key,
        old?.from === from && old.to === to
          ? old
          : {
              key,
              from,
              fromJack: c.from.jack,
              to,
              toId: c.to.gear,
              jack: c.to.jack,
              open: new Map(),
            },
      );
    }
    const live = new Set(this.units.values());
    for (const [key, line] of this.noteLines) {
      if (lines.get(key) === line) continue;
      // Gear that was removed has been disposed: it has nothing left to stop.
      if (live.has(line.to)) this.release(line);
    }
    this.noteLines.clear();
    for (const unit of this.units.values()) {
      for (const jack of Object.keys(unit.noteOuts)) unit.noteOuts[jack] = undefined;
    }
    for (const [key, line] of lines) {
      this.noteLines.set(key, line);
      line.from.noteOuts[line.fromJack] = (e) => this.send(line, e);
    }
  }

  /** Passes one event down a NOTE cable, keeping track of the voices it leaves sounding. */
  private send(line: NoteLine, e: NoteEvent) {
    if (e.type === 'on') line.open.set(e.voice, e.note);
    else if (e.type === 'off') line.open.delete(e.voice);
    this.deliver(line, e);
  }

  /** Stops every voice a NOTE cable still has sounding. */
  private release(line: NoteLine) {
    const open = [...line.open];
    line.open.clear();
    for (const [voice, note] of open) this.deliver(line, { type: 'off', voice, note });
  }

  /**
   * Hands an event to the gear at the end of a NOTE cable. Gear that reads note events itself
   * gets them as they are; a synth that only knows keys plays the note as if its key went down
   * (per-note expression doesn't reach it). An instrument then passes the note on through its
   * NOTE OUT.
   */
  private deliver(line: NoteLine, e: NoteEvent) {
    const to = line.to;
    if (to.receive) to.receive(line.jack, e);
    else if (isPlayable(to)) this.playCableNote(line, to, e);
    const gear = this.store.patch().gear.find((g) => g.id === line.toId);
    if (gear && GEAR[gear.kind].category === 'synth') {
      if (e.type !== 'expr') this.hold(line.toId, e.note, e.type === 'on');
      this.thru(line.toId, `${line.key}:${e.voice}`, e);
    }
  }

  /** Notes a key-only synth is playing from NOTE cables, with how many voices hold each. */
  private readonly cableNotes = new Map<Unit, Map<number, number>>();

  private playCableNote(line: NoteLine, unit: Unit & Playable, e: NoteEvent) {
    if (e.type === 'expr') return;
    let counts = this.cableNotes.get(unit);
    if (!counts) this.cableNotes.set(unit, (counts = new Map()));
    const n = counts.get(e.note) ?? 0;
    if (e.type === 'on') {
      counts.set(e.note, n + 1);
      unit.noteOn(e.note, e.note - this.base());
    } else if (n > 0) {
      // Two voices on the same note: the key comes up when the last one lets go.
      if (n > 1) counts.set(e.note, n - 1);
      else {
        counts.delete(e.note);
        unit.noteOff(e.note);
      }
    }
  }

  /** Lights (or unlights) a key on an instrument's keyboard. */
  private hold(id: string, note: number, on: boolean) {
    this.held.update((h) => {
      const rest = (h[id] ?? []).filter((n) => n !== note);
      return { ...h, [id]: on ? [...rest, note] : rest };
    });
  }

  // ── NOTE OUT on instruments ───────────────────────────

  /**
   * Voices an instrument is sending out of its NOTE OUT, keyed by where each note came from
   * (a key, a track, or a voice on a NOTE cable): every note it plays goes out with a voice id
   * of its own, so notes from different places never get mixed up downstream.
   */
  private readonly thruVoices = new Map<string, Map<string, number>>();
  private nextThru = 1;

  /** Sends a note an instrument is playing out of its NOTE OUT (synths only: note effects send their own). */
  private thru(id: string, source: string, e: NoteEvent) {
    const gear = this.store.patch().gear.find((g) => g.id === id);
    if (!gear || GEAR[gear.kind].category !== 'synth') return;
    let voices = this.thruVoices.get(id);
    if (!voices) this.thruVoices.set(id, (voices = new Map()));
    if (e.type === 'on') {
      const old = voices.get(source);
      if (old !== undefined) this.emitThru(id, { type: 'off', voice: old, note: e.note });
      const voice = this.nextThru++;
      voices.set(source, voice);
      this.emitThru(id, { ...e, voice });
      return;
    }
    const voice = voices.get(source);
    if (voice === undefined) return;
    if (e.type === 'off') voices.delete(source);
    this.emitThru(id, { ...e, voice });
  }

  private emitThru(id: string, e: NoteEvent) {
    this.units.get(id)?.noteOuts[NOTE_OUT]?.(e);
  }

  // ── Recording taps and take playback ──────────────────

  /** Live recording taps: worklet node → what it records (a gear id, or 'main' for the mix). */
  private readonly captures = new Map<AudioWorkletNode, string>();
  private worklet?: Promise<void>;
  /** Takes play into MAIN • REC through this bus (so MAIN's volume, limiter and meter apply). */
  private bus?: GainNode;

  /** The audio context, once sound has started (for scheduling takes). */
  get context(): AudioContext | undefined {
    return this.ctx;
  }

  private sourceNode(source: string): AudioNode | undefined {
    const id =
      source === 'main' ? this.store.patch().gear.find((g) => g.kind === 'output')?.id : source;
    return id ? this.units.get(id)?.tap : undefined;
  }

  /** The bus that recorded takes play into. */
  trackBus(): GainNode | undefined {
    if (!this.ctx) return undefined;
    if (!this.bus) {
      this.bus = this.ctx.createGain();
      this.connectTrackBus();
    }
    return this.bus;
  }

  private connectTrackBus() {
    if (!this.bus) return;
    const out = this.store.patch().gear.find((g) => g.kind === 'output');
    const input = out && this.units.get(out.id)?.inputs['in'];
    if (input) {
      this.bus.disconnect();
      this.bus.connect(input);
    }
  }

  /**
   * Records `source` ('main' for the mix, or a gear id): blocks of audio arrive as the audio
   * thread captures them; `stop()` resolves with every block and the audio frame the first one
   * started on (to line the take up with the song).
   */
  async capture(
    source: string,
  ): Promise<{ stop: () => Promise<{ frame: number; chunks: Float32Array[][] }> }> {
    this.start();
    const ctx = this.ctx!;
    this.worklet ??= ctx.audioWorklet.addModule(
      new URL('worklets/capture.js', document.baseURI).href,
    );
    await this.worklet;
    const node = new AudioWorkletNode(ctx, 'klinke-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    // Nodes only run while connected towards the speakers: through a silent gain.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    this.captures.set(node, source);
    this.sourceNode(source)?.connect(node);
    const chunks: Float32Array[][] = [];
    let frame = -1;
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    node.port.onmessage = (e) => {
      if (e.data.done) return finish();
      if (frame < 0) frame = e.data.frame;
      chunks.push(e.data.channels);
    };
    return {
      stop: async () => {
        node.port.postMessage('stop');
        await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
        this.captures.delete(node);
        node.disconnect();
        sink.disconnect();
        return { frame: Math.max(0, frame), chunks };
      },
    };
  }

  // ── Meters ────────────────────────────────────────────

  private meterLoop() {
    let frame = 0;
    const tick = () => {
      requestAnimationFrame(tick);
      if (!this.running() || frame++ % 2) return; // ~30 fps is plenty for meters
      const levels: Record<string, number[]> = {};
      const statuses: Record<string, string> = {};
      for (const [id, unit] of this.units) {
        const m = unit.meters();
        if (m.length) levels[id] = m;
        const st = unit.status();
        if (st !== null) statuses[id] = st;
      }
      this.statuses.set(statuses);
      this.levels.set(levels);
    };
    requestAnimationFrame(tick);
  }

  // ── Web MIDI ──────────────────────────────────────────

  private async connectMidi() {
    if (!('requestMIDIAccess' in navigator)) return this.midi.set('unsupported');
    if (!isSecureContext) return this.midi.set('insecure');
    try {
      const access = await navigator.requestMIDIAccess();
      const attach = () => {
        const names: string[] = [];
        access.inputs.forEach((input) => {
          names.push(input.name ?? 'MIDI input');
          input.onmidimessage = (e) => {
            const msg = e.data && parseMidi(e.data);
            if (msg?.type === 'on') this.noteOn(msg.note);
            else if (msg?.type === 'off') this.noteOff(msg.note);
            else if (msg?.type === 'bend') this.pitchBend(msg.value);
            else if (msg?.type === 'cc' && msg.controller === 1) this.modWheel(msg.value);
          };
        });
        this.midiInputs.set(names);
      };
      attach();
      access.onstatechange = attach;
      this.midi.set('ready');
    } catch {
      this.midi.set('denied');
    }
  }
}

/** A short silent WAV as a data URL (8 kHz, 8-bit, 0.5 s) for the iOS playback-session loop. */
function silentWav(): string {
  const samples = 4000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit silence is the midpoint
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}
