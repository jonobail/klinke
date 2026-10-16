// The base for every Web Audio "unit": one per piece of gear on the floor. A unit exposes an
// AudioNode per IN jack and one for its OUT jack; the engine patches those together to match
// the cables.

import { meterLevel } from '../core/sound';

export type Params = Record<string, number>;

/**
 * One event on a NOTE cable: MIDI with MPE-style per-note expression. Each sounding note is a
 * `voice` (like an MPE member channel) from its 'on' to its 'off'; 'expr' moves it while it
 * sounds. Expression fields left out keep their last value (on 'on': bend 0, pressure =
 * velocity, timbre 0.5).
 */
export interface NoteEvent {
  type: 'on' | 'off' | 'expr';
  /** Identifies the voice from 'on' to 'off'; unique among the sender's sounding voices. */
  voice: number;
  /** The MIDI note the voice started on ('expr' and 'off' repeat it). */
  note: number;
  /** 0–1, sent with 'on'. */
  velocity?: number;
  /** Pitch offset from `note`, in semitones (per-note pitch bend, ±48). */
  bend?: number;
  /** 0–1: per-note pressure (MPE channel pressure). */
  pressure?: number;
  /** 0–1: per-note timbre (MPE CC74 / slide). */
  timbre?: number;
}

export type NoteHandler = (e: NoteEvent) => void;

/** Smooths every knob move so nothing zips or clicks. */
export const glide = (param: AudioParam, value: number, ctx: BaseAudioContext, time = 0.02) =>
  param.setTargetAtTime(value, ctx.currentTime, time);

/** Freezes an automated param at its current (or scheduled) value from time `t` onward. */
export function holdAt(param: AudioParam, t: number) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
  else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
  }
}

export abstract class Unit {
  readonly inputs: Record<string, AudioNode> = {};
  /** The `out` jack. */
  output?: AudioNode;
  /** Any other OUT jacks (the MF-104's LOOP OUT), by jack id. */
  readonly outs: Record<string, AudioNode> = {};
  protected analysers: AnalyserNode[] = [];
  private scratch?: Float32Array<ArrayBuffer>;

  constructor(protected readonly ctx: AudioContext) {}

  abstract set(p: Params): void;

  /** Current meter readings, one per analyser. */
  meters(): number[] {
    return this.analysers.map((a) => {
      this.scratch ??= new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(this.scratch);
      return meterLevel(this.scratch);
    });
  }

  dispose() {
    for (const n of Object.values(this.inputs)) n.disconnect();
    this.output?.disconnect();
    for (const n of Object.values(this.outs)) n.disconnect();
  }

  /** A line of live state for the gear's display (the SP-1200's sampling status), if any. */
  status(): string | null {
    return null;
  }

  /**
   * NOTE OUT jacks, by jack id: the engine points each at whatever its cable plugs into (and
   * clears it when unplugged).
   */
  readonly noteOuts: Record<string, NoteHandler | undefined> = {};

  /** Sends a note event out of a NOTE OUT jack. */
  protected emit(e: NoteEvent, jack = 'notesOut') {
    this.noteOuts[jack]?.(e);
  }

  /** A note event arriving at one of this gear's NOTE IN jacks (gear with NOTE IN jacks implement it). */
  receive?(jack: string, e: NoteEvent): void;

  /** The song tempo, in BPM: sent when the unit is made and whenever it changes. */
  setTempo(_bpm: number): void {}

  /** Set by the engine: saves a text setting into the patch (e.g. the SH-101's sequence). */
  saveText?: (key: string, value: string) => void;

  /** Text settings changed (e.g. the SH-101's stored sequence). */
  setText(_text: Record<string, string>): void {}

  /** A front-panel action that isn't a stored setting (e.g. "arm sampling"). */
  command(_name: string): void {}

  /** What recording this gear captures: its OUT jack (MAIN • REC overrides it with the mix). */
  get tap(): AudioNode | undefined {
    return this.output;
  }

  /** The node behind an OUT jack. */
  outputFor(jack: string): AudioNode | undefined {
    return jack === 'out' ? this.output : this.outs[jack];
  }

  /** Unplugs every OUT jack, ready for the engine to re-patch. */
  unplugOutputs() {
    this.output?.disconnect();
    for (const n of Object.values(this.outs)) n.disconnect();
  }

  protected analyser(source: AudioNode) {
    const a = this.ctx.createAnalyser();
    a.fftSize = 512;
    source.connect(a);
    this.analysers.push(a);
  }
}

/** A unit you can play: the synths. */
export interface Playable {
  /** `step` is the note's distance from the keyboard's base C (the SP-1200 maps it to pads). */
  noteOn(note: number, step: number): void;
  noteOff(note: number): void;
  allNotesOff(): void;
  /** Pitch wheel / MIDI pitch bend, -1…+1 (0 = centre). */
  pitchBend(amount: number): void;
}

export const isPlayable = (u: Unit | undefined): u is Unit & Playable => !!u && 'noteOn' in u;
