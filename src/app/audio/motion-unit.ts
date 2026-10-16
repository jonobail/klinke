// MOTION-15 note handling: no sound, only NOTE events. Plain notes (from NOTE IN or the keys)
// become a pool of up to 15 output voices, each moved continuously by 'expr' events:
//
//   notes in ─ chord window (30 ms) ─ voice leading ─ glides (curve, path, stagger, spread) ─┐
//   autopilot steps (pattern, synced or free) ───────────────── more glide targets ──────────┤
//   swell · timbre wander · delayed vibrato · drift · modulators · global bend · release ────┴→ NOTE OUT
//
// A voice's note is fixed at its 'on'; everything after is bend from it (±48 semitones), so a
// chord change glides the same voices to the new notes instead of retriggering. A released
// voice waits LEGATO for a new note to glide to before it lets go (with its release bend).

import {
  BEND_RANGE,
  CHORD_WINDOW_MS,
  type MotionSettings,
  PATTERN_STEPS,
  assignVoices,
  autoStepSeconds,
  autopilotOffsets,
  bendShapeAt,
  curveAt,
  driftAt,
  encodeStatus,
  evolvePattern,
  glideTime,
  modAt,
  motionSettings,
  parsePattern,
  pathAt,
  reachable,
  releaseAt,
  rng,
  spreadFactor,
  staggerDelays,
  startOffset,
  swellAt,
  vibratoEnv,
  wanderAt,
} from '../core/motion';
import { type NoteEvent, type Params, type Playable, Unit } from './unit';

const TICK_MS = 12;
/** Keys and MIDI carry no velocity. */
const KEY_VELOCITY = 0.8;
/** Smallest changes worth an 'expr' event. */
const EPS_BEND = 0.003;
const EPS_LEVEL = 0.004;
/** The pitch wheel's range, semitones. */
const WHEEL_RANGE = 2;

/** A note held at the input (from NOTE IN or the keys). */
interface Input {
  key: string;
  note: number;
  /** Incoming per-note expression (from an upstream note effect). */
  bend: number;
  velocity: number;
  pressure: number;
  timbre: number;
  /** Arrival order. */
  order: number;
  voice?: Voice;
}

interface Glide {
  from: number;
  t0: number;
  dur: number;
}

interface Voice {
  id: number;
  /** The note sent with 'on': every later pitch is bend from it. */
  note: number;
  /** Pool slot 0–14: modulator phase and which way the paths turn. */
  slot: number;
  owner: Input | null;
  /** Where it was heading when its input let go. */
  lastTarget: number;
  lastPressure: number;
  lastTimbre: number;
  /** Orphaned voices: when they give up waiting for a new note. */
  orphanUntil: number;
  /** Autopilot offset, semitones. */
  auto: number;
  glide: Glide | null;
  /** The glide pitch (before vibrato, drift and the rest) as of the last tick. */
  gp: number;
  startedAt: number;
  settledAt: number;
  vibAmp: number;
  vibPhase: number;
  release: { t0: number; dur: number } | null;
  sent: { bend: number; pressure: number; timbre: number };
}

const now = () => performance.now() / 1000;

export class MotionUnit extends Unit implements Playable {
  private s: MotionSettings = motionSettings({});
  private bpm = 120;
  private readonly notesHeld = new Map<string, Input>();
  private voices: Voice[] = [];
  private order = 0;
  private nextId = 1;
  private batch?: ReturnType<typeof setTimeout>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly random = rng(Date.now() & 0xffff);
  private wheel = 0;
  /** When the current phrase (voices sounding without a gap) began: the global bend's clock. */
  private phraseStart = 0;
  private stored = parsePattern(undefined);
  private pattern = this.stored.slice();
  private autoPos = -1;
  private nextStep = 0;
  private autoSeed = 1;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  set(p: Params) {
    const prev = this.s;
    this.s = motionSettings(p);
    if (prev.auto !== this.s.auto) {
      this.autoPos = -1;
      this.nextStep = 0;
      this.pattern = this.stored.slice();
      // Bring everything home (the new mode takes over on its next step).
      this.moveAuto(this.held().map(() => 0));
    }
  }

  override setTempo(bpm: number) {
    if (bpm > 0) this.bpm = bpm;
  }

  override setText(text: Record<string, string>) {
    this.stored = parsePattern(text['pattern']);
    this.pattern = this.stored.slice();
  }

  override status(): string {
    const views = this.voices.map((v) => ({
      id: v.id,
      pitch: v.note + v.sent.bend,
      pressure: v.sent.pressure,
      releasing: !!v.release || !v.owner,
    }));
    const step = this.s.auto !== 'OFF' && this.autoPos >= 0 ? this.autoPos % PATTERN_STEPS : -1;
    return encodeStatus(views, step);
  }

  override dispose() {
    clearInterval(this.timer);
    clearTimeout(this.batch);
    this.allNotesOff();
    super.dispose();
  }

  // ── Input ─────────────────────────────────────────────

  override receive(_jack: string, e: NoteEvent) {
    const key = 'n' + e.voice;
    if (e.type === 'on') this.inputOn(key, e.note, e.velocity ?? KEY_VELOCITY, e);
    else if (e.type === 'off') this.inputOff(key);
    else {
      const i = this.notesHeld.get(key);
      if (!i) return;
      if (e.bend !== undefined) i.bend = e.bend;
      if (e.pressure !== undefined) i.pressure = e.pressure;
      if (e.timbre !== undefined) i.timbre = e.timbre;
    }
  }

  noteOn(note: number) {
    this.inputOn('k' + note, note, KEY_VELOCITY);
  }

  noteOff(note: number) {
    this.inputOff('k' + note);
  }

  allNotesOff() {
    clearTimeout(this.batch);
    this.batch = undefined;
    for (const v of this.voices) this.emit({ type: 'off', voice: v.id, note: v.note });
    this.voices = [];
    this.notesHeld.clear();
  }

  pitchBend(amount: number) {
    this.wheel = amount * WHEEL_RANGE;
  }

  private inputOn(key: string, note: number, velocity: number, e?: NoteEvent) {
    if (this.notesHeld.has(key)) this.inputOff(key);
    this.notesHeld.set(key, {
      key,
      note,
      bend: e?.bend ?? 0,
      velocity,
      pressure: e?.pressure ?? velocity,
      timbre: e?.timbre ?? 0.5,
      order: this.order++,
    });
    this.schedule();
  }

  private inputOff(key: string) {
    const i = this.notesHeld.get(key);
    if (!i) return; // duplicate offs (after all-notes-off, or an unplugged cable)
    this.notesHeld.delete(key);
    if (i.voice) this.orphan(i.voice, now() + CHORD_WINDOW_MS / 1000 + this.s.legato);
    this.schedule();
  }

  /** Changes within the chord window are resolved together, so a chord change is one move. */
  private schedule() {
    this.batch ??= setTimeout(() => {
      this.batch = undefined;
      this.resolve();
    }, CHORD_WINDOW_MS);
  }

  private orphan(v: Voice, until: number) {
    if (!v.owner) return;
    v.lastTarget = this.target(v);
    v.lastPressure = v.owner.pressure;
    v.lastTimbre = v.owner.timbre;
    v.owner.voice = undefined;
    v.owner = null;
    v.orphanUntil = until;
  }

  /** The held voices (owned and not releasing). */
  private held() {
    return this.voices.filter((v) => v.owner && !v.release);
  }

  // ── Voice leading ─────────────────────────────────────

  private resolve() {
    const t = now();
    const s = this.s;
    const held = [...this.notesHeld.values()].sort((a, b) => a.order - b.order);
    const desired = held.slice(-s.voices);
    const wanted = new Set(desired);
    // Inputs over the voice limit hand their voice on (VOICES 1 is a legato mono line).
    for (const i of held) if (!wanted.has(i) && i.voice) this.orphan(i.voice, t + s.legato);
    const free = this.voices.filter((v) => !v.owner && !v.release);
    const fresh = desired.filter((i) => !i.voice);
    if (!fresh.length) return;
    if (!this.voices.some((v) => !v.release)) this.startPhrase(t);
    const map = assignVoices(
      free.map((v) => v.gp),
      fresh.map((i) => i.note + i.bend),
      s.leading,
    );
    const moving: Voice[] = [];
    const taken = new Set<Input>();
    free.forEach((v, n) => {
      const i = map[n] >= 0 ? fresh[map[n]] : undefined;
      if (!i) return;
      taken.add(i);
      if (reachable(v.note, i.note + i.bend) === null) {
        this.releaseNow(v, t, true);
        return this.startVoice(i, t);
      }
      v.owner = i;
      i.voice = v;
      v.auto = 0;
      moving.push(v);
    });
    const delays = staggerDelays(
      moving.map((v) => this.target(v)),
      s.stagger,
      s.staggerTime,
      this.random,
    );
    moving.forEach((v, n) => this.glideTo(v, v.gp, t + delays[n]));
    for (const i of fresh) if (!taken.has(i)) this.startVoice(i, t);
  }

  private startPhrase(t: number) {
    this.phraseStart = t;
    this.autoPos = -1;
    this.nextStep = 0;
    this.pattern = this.stored.slice();
    this.autoSeed = Math.floor(this.random() * 1e6);
  }

  private startVoice(i: Input, t: number) {
    const s = this.s;
    // Keep within the limit: the longest-waiting orphans make room.
    const live = () => this.voices.filter((v) => !v.release);
    while (live().length >= s.voices) {
      const spare = live().find((v) => !v.owner);
      if (!spare) break;
      this.releaseNow(spare, t);
    }
    const used = new Set(this.voices.map((v) => v.slot));
    let slot = 0;
    while (used.has(slot) && slot < 63) slot++;
    const pitch = i.note + i.bend;
    const from = pitch + startOffset(s.start, s.startBend, slot, this.random);
    const v: Voice = {
      id: this.nextId,
      note: i.note,
      slot,
      owner: i,
      lastTarget: pitch,
      lastPressure: i.pressure,
      lastTimbre: i.timbre,
      orphanUntil: 0,
      auto: 0,
      glide: null,
      gp: from,
      startedAt: t,
      settledAt: t,
      vibAmp: 0,
      vibPhase: this.random(),
      release: null,
      sent: { bend: from - i.note, pressure: 0, timbre: i.timbre },
    };
    this.nextId = (this.nextId % 0xffff) + 1;
    i.voice = v;
    this.voices.push(v);
    const pressure = i.pressure * swellAt(0, s.swell);
    v.sent.pressure = pressure;
    this.emit({
      type: 'on',
      voice: v.id,
      note: v.note,
      velocity: i.velocity,
      bend: v.sent.bend,
      pressure,
      timbre: i.timbre,
    });
    if (from !== pitch) this.glideTo(v, from, t);
  }

  /** Starts a glide from `from` towards the voice's (live) target. */
  private glideTo(v: Voice, from: number, t0: number) {
    const dist = this.target(v) - from;
    const dur = glideTime(this.s, dist) * spreadFactor(v.slot + 1, this.s.spread);
    if (dur < 0.005 || Math.abs(dist) < 1e-4) {
      v.glide = null;
      v.gp = this.target(v);
      return;
    }
    v.glide = { from, t0, dur };
    v.settledAt = t0 + dur;
  }

  private releaseNow(v: Voice, t: number, instant = false) {
    if (v.release) return;
    const dur = instant || this.s.release === 'NONE' ? 0 : this.s.releaseTime;
    if (v.owner) this.orphan(v, t);
    if (dur <= 0) {
      this.emit({ type: 'off', voice: v.id, note: v.note });
      this.voices = this.voices.filter((x) => x !== v);
    } else v.release = { t0: t, dur };
  }

  // ── Autopilot ─────────────────────────────────────────

  private autopilot(t: number) {
    const s = this.s;
    if (s.auto === 'OFF') return;
    const held = this.held();
    if (!held.length) return;
    const stepSec = autoStepSeconds(s, this.bpm);
    // The first step plays once the voices have had time to arrive.
    if (this.autoPos < 0) {
      this.autoPos = 0;
      this.nextStep = t + stepSec;
      return;
    }
    if (t < this.nextStep) return;
    this.nextStep = t - this.nextStep > stepSec ? t + stepSec : this.nextStep + stepSec;
    this.autoPos++;
    if (this.autoPos % PATTERN_STEPS === 0 && s.evolve)
      this.pattern = evolvePattern(this.pattern, this.random);
    const homes = held.map((v) => v.owner!.note + v.owner!.bend);
    this.moveAuto(
      autopilotOffsets(s.auto, this.pattern, this.autoPos, homes, s.autoAmount, this.autoSeed),
    );
  }

  /** Sets the held voices' autopilot offsets, gliding (and staggering) the ones that change. */
  private moveAuto(offsets: number[]) {
    const t = now();
    const held = this.held();
    const moving: Voice[] = [];
    held.forEach((v, n) => {
      const o = offsets[n] ?? 0;
      const home = v.owner!.note + v.owner!.bend;
      if (o === v.auto || reachable(v.note, home + o) === null) return;
      v.auto = o;
      moving.push(v);
    });
    const delays = staggerDelays(
      moving.map((v) => this.target(v)),
      this.s.stagger,
      this.s.staggerTime,
      this.random,
    );
    moving.forEach((v, n) => this.glideTo(v, v.gp, t + delays[n]));
  }

  // ── Control rate ──────────────────────────────────────

  private target(v: Voice) {
    return v.owner ? v.owner.note + v.owner.bend + v.auto : v.lastTarget;
  }

  private tick() {
    const t = now();
    const s = this.s;
    this.autopilot(t);
    const bendLen = (s.bendBeats * 60) / this.bpm;
    const global =
      s.bendShape === 'OFF'
        ? 0
        : bendShapeAt(s.bendShape, (t - this.phraseStart) / bendLen, s.bendLoop) * s.bendDepth;
    for (const v of [...this.voices]) {
      if (!v.owner && !v.release && t >= v.orphanUntil) this.releaseNow(v, t);
      if (!this.voices.includes(v)) continue;
      const target = this.target(v);
      let pitch = target;
      let pathTimbre = 0;
      const g = v.glide;
      if (g) {
        if (t < g.t0) pitch = g.from;
        else {
          const x = (t - g.t0) / g.dur;
          if (x >= 1) v.glide = null;
          else {
            const path = pathAt(s.path, x, v.slot % 2 ? -1 : 1);
            pitch = g.from + (target - g.from) * curveAt(s.curve, x) + path.pitch * s.pathDepth;
            pathTimbre = path.timbre * Math.min(1, s.pathDepth / 6);
          }
        }
      }
      v.gp = pitch;

      // Modulators
      let mPitch = 0;
      let mPressure = 0;
      let mTimbre = 0;
      let mVib = 0;
      for (const m of s.mods) {
        if (m.depth <= 0) continue;
        const val = modAt(m, t - v.startedAt, v.slot, s.modSpread) * m.depth;
        if (m.dest === 'PITCH') mPitch += val * 2;
        else if (m.dest === 'PRESSURE') mPressure += val * 0.5;
        else if (m.dest === 'TIMBRE') mTimbre += val * 0.5;
        else mVib += val;
      }

      // Delayed vibrato, faded in once the voice has arrived and out while it glides.
      const vibTarget = v.glide ? 0 : vibratoEnv(t - v.settledAt, s.vibDelay);
      v.vibAmp += (vibTarget - v.vibAmp) * Math.min(1, TICK_MS / 1000 / 0.15);
      const life = t - v.startedAt;
      const vib =
        v.vibAmp *
        s.vibDepth *
        Math.max(0, 1 + mVib) *
        Math.sin(2 * Math.PI * (s.vibRate * life + v.vibPhase));
      const drift = driftAt(v.id, life, s.drift);
      let rel = 0;
      let relFade = 1;
      if (v.release) {
        const x = (t - v.release.t0) / v.release.dur;
        if (x >= 1) {
          this.emit({ type: 'off', voice: v.id, note: v.note });
          this.voices = this.voices.filter((o) => o !== v);
          continue;
        }
        rel = releaseAt(s.release, s.releaseBend, x);
        relFade = 1 - x * 0.6;
      }
      const total = pitch + global + this.wheel + vib + drift + mPitch + rel;
      const bend = Math.max(-BEND_RANGE, Math.min(BEND_RANGE, total - v.note));
      const basePressure = v.owner ? v.owner.pressure : v.lastPressure;
      const baseTimbre = v.owner ? v.owner.timbre : v.lastTimbre;
      const pressure = clamp01(basePressure * swellAt(life, s.swell) * relFade + mPressure);
      const timbre = clamp01(baseTimbre + wanderAt(v.id, life, s.wander) + pathTimbre + mTimbre);
      const e: NoteEvent = { type: 'expr', voice: v.id, note: v.note };
      let changed = false;
      if (Math.abs(bend - v.sent.bend) > EPS_BEND) {
        e.bend = v.sent.bend = bend;
        changed = true;
      }
      if (Math.abs(pressure - v.sent.pressure) > EPS_LEVEL) {
        e.pressure = v.sent.pressure = pressure;
        changed = true;
      }
      if (Math.abs(timbre - v.sent.timbre) > EPS_LEVEL) {
        e.timbre = v.sent.timbre = timbre;
        changed = true;
      }
      if (changed) this.emit(e);
    }
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
