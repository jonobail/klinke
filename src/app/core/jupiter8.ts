// JUPITER-8 (1981): 8-voice polyphonic, after the service notes (Oct. 1981 / Dec. 1982):
// specifications p.1, functional diagram p.6, module board and module controller block diagrams
// p.7, module controller circuit p.11, adjustment procedures pp.26–29 (with the panel drawing).
//
// Per voice (module board, p.7): VCO-1 and VCO-2 → waveform converters and selects → SOURCE MIX
// → HPF → VCF (12 / 24 dB taps, RES loop) → VCA, with ENV-1 (VCF, VCO MOD, PWM) and ENV-2 (VCA),
// both with key follow. Shared per module controller (p.7, p.11): the LFO with its delay, the
// noise generator, VCO / VCF / VCA modulation, the bender. The CPU assigns keys to the voices and
// runs the arpeggio. Interpretation notes in docs/devices/jupiter8.md.
//
// Everything here is pure: settings, the arpeggio, the key assigner and the voice DSP
// (`Jupiter8Dsp`), which the audio unit runs inside an AudioWorklet.

import { type GearDef, bi, noteJacks, p, sel } from './gear-types.ts';
import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

export const VOICES = 8;

/** RANGE 64'–2', against 8'. */
export const RANGES = ["64'", "32'", "16'", "8'", "4'", "2'"];
const RANGE_OCT = [-3, -2, -1, 0, 1, 2];
export const VCO1_WAVES = ['TRIANGLE', 'SAWTOOTH', 'PULSE', 'SQUARE'];
export const VCO2_WAVES = ['SINE', 'SAWTOOTH', 'PULSE', 'NOISE'];
export const LFO_WAVES = ['SINE', 'SAWTOOTH', 'SQUARE', 'RANDOM'];
export const MOD_DESTS = ['VCO-1', 'BOTH', 'VCO-2'];
export const PWM_SOURCES = ['LFO', 'MANUAL', 'ENV-1'];
export const ASSIGN_MODES = ['SOLO', 'UNISON', 'POLY 1', 'POLY 2'];
export const ARP_MODES = ['OFF', 'UP', 'DOWN', 'U&D', 'RANDOM'];
/** EXT clock: the song tempo, at these note values (beats per step). */
export const ARP_DIVISIONS = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
const DIVISION_BEATS = [1, 1 / 2, 1 / 3, 1 / 4, 1 / 6, 1 / 8];

export type Assign = 'solo' | 'unison' | 'poly1' | 'poly2';
const ASSIGNS: Assign[] = ['solo', 'unison', 'poly1', 'poly2'];
export type ArpMode = 'off' | 'up' | 'down' | 'updown' | 'random';
const ARPS: ArpMode[] = ['off', 'up', 'down', 'updown', 'random'];

/** VCO-2 LOW FREQ: the same keyboard tracking, this many octaves down (sub-audio at 8'). */
export const LOW_FREQ_OCTAVES = 7;

const onOff = (id: string, label: string, on: boolean) => sel(id, label, ['OFF', 'ON'], on ? 1 : 0);
const slider = (id: string, label: string, def: number) => ({ ...p(id, label, def), slider: true });

export const JUPITER8_GEAR: GearDef = {
  kind: 'jupiter8',
  label: 'JUPITER-8',
  category: 'synth',
  w: 30,
  h: 11,
  // The jacks sit in the strip along the back, top right, by their printed names.
  jacks: [
    ...noteJacks([0.895, 0.026], [0.93, 0.026]),
    { id: 'out', dir: 'out', fx: 0.975, fy: 0.026, label: 'OUTPUT' },
  ],
  params: [
    p('volume', 'VOLUME', 0.7),
    slider('arpRate', 'ARPEGGIO RATE', 0.6),
    sel('arpClock', 'ARPEGGIO CLOCK', ['INT', 'EXT (TEMPO)'], 1),
    sel('arpMode', 'ARPEGGIO MODE', ['OFF', 'UP', 'DOWN', 'U&D', 'RANDOM'], 0),
    sel('arpRange', 'ARPEGGIO RANGE', ['1', '2', '3', '4'], 0),
    onOff('hold', 'HOLD', false),
    sel('assign', 'ASSIGN MODE', ASSIGN_MODES, 3),
    slider('lfoRate', 'LFO RATE', 0.5),
    slider('lfoDelay', 'LFO DELAY TIME', 0),
    sel('lfoWave', 'LFO WAVE FORM', LFO_WAVES, 0),
    slider('modLfo', 'VCO MOD LFO', 0),
    slider('modEnv', 'VCO MOD ENV', 0),
    sel('modDest', 'VCO MOD', MOD_DESTS, 1),
    slider('pwm', 'PULSE WIDTH MOD', 0.3),
    sel('pwmSource', 'PWM', PWM_SOURCES, 1),
    slider('crossMod', 'CROSS MOD', 0),
    sel('range1', 'VCO-1 RANGE', RANGES, 2),
    sel('wave1', 'VCO-1 WAVE FORM', VCO1_WAVES, 1),
    onOff('sync', 'SYNC', false),
    sel('lowFreq', 'VCO-2 RANGE MODE', ['NORMAL', 'LOW FREQ'], 0),
    sel('range2', 'VCO-2 RANGE', RANGES, 2),
    bi('fine2', 'VCO-2 FINE TUNE', 0.54),
    sel('wave2', 'VCO-2 WAVE FORM', VCO2_WAVES, 1),
    p('sourceMix', 'SOURCE MIX', 0.5),
    slider('hpf', 'HPF CUTOFF FREQ', 0),
    slider('cutoff', 'VCF CUTOFF FREQ', 0.55),
    slider('res', 'VCF RES', 0.15),
    sel('slope', 'VCF SLOPE', ['12 dB/OCT', '24 dB/OCT'], 1),
    slider('vcfEnv', 'VCF ENV MOD', 0.4),
    sel('vcfEnvSel', 'VCF ENV', ['ENV-1', 'ENV-2'], 0),
    slider('vcfLfo', 'VCF LFO MOD', 0),
    slider('keyFollow', 'VCF KEY FOLLOW', 0.5),
    slider('level', 'VCA LEVEL', 0.8),
    sel('vcaLfo', 'VCA LFO MOD', ['0', '1', '2', '3'], 0),
    slider('env1A', 'ENV-1 A', 0.05),
    slider('env1D', 'ENV-1 D', 0.45),
    slider('env1S', 'ENV-1 S', 0.3),
    slider('env1R', 'ENV-1 R', 0.4),
    onOff('env1Kf', 'ENV-1 KEY FOLLOW', false),
    sel('env1Pol', 'ENV-1 POLARITY', ['POSITIVE', 'NEGATIVE'], 0),
    slider('env2A', 'ENV-2 A', 0.04),
    slider('env2D', 'ENV-2 D', 0.45),
    slider('env2S', 'ENV-2 S', 0.75),
    slider('env2R', 'ENV-2 R', 0.4),
    onOff('env2Kf', 'ENV-2 KEY FOLLOW', false),
    bi('tune', 'MASTER TUNE'),
    p('portaTime', 'PORTAMENTO', 0.3),
    onOff('porta', 'PORTAMENTO', false),
    onOff('bendVco1', 'BEND VCO-1', true),
    onOff('bendVco2', 'BEND VCO-2', true),
    onOff('bendVcfOn', 'BEND VCF', false),
    slider('bendVco', 'BEND VCO', 0.17),
    slider('bendVcf', 'BEND VCF', 0.3),
    slider('lfoModVco', 'LFO MOD VCO', 0.35),
    slider('lfoModVcf', 'LFO MOD VCF', 0),
  ],
  keyboard: { from: -12, keys: 61 }, // 61 notes, 5 octaves (spec)
};

/** Time slider → seconds, fully down at the spec's minimum. */
const time = (v: number, min: number, max: number) => expMap(v, min, max);
const on = (v: number | undefined) => (v ?? 0) >= 0.5;

export function jupiter8Settings(p: Params) {
  return {
    volume: p['volume'] * p['volume'],
    /** ARPEGGIO RATE 1–20 Hz (spec) on the internal clock; on EXT a note value of the tempo. */
    arpHz: expMap(p['arpRate'], 1, 20),
    arpDivision: stepIndex(p['arpRate'], ARP_DIVISIONS.length),
    arpExt: on(p['arpClock']),
    arp: ARPS[stepIndex(p['arpMode'], ARPS.length)],
    arpRange: stepIndex(p['arpRange'], 4) + 1,
    hold: on(p['hold']),
    assign: ASSIGNS[stepIndex(p['assign'], 4)],
    lfoRate: expMap(p['lfoRate'], 0.05, 40), // 0.05–40 Hz (spec)
    lfoDelay: p['lfoDelay'] * 4, // 0–4 s (spec)
    lfoWave: stepIndex(p['lfoWave'], 4),
    /** VCO MOD from the LFO: full scale swings the VCO two octaves, ±1 (p.29 §22), in cents. */
    modLfo: p['modLfo'] * p['modLfo'] * 1200,
    /** VCO MOD from ENV-1: full scale shifts the VCOs three octaves (p.26 §8), in cents. */
    modEnv: p['modEnv'] * 3600,
    modVco1: stepIndex(p['modDest'], 3) <= 1,
    modVco2: stepIndex(p['modDest'], 3) >= 1,
    /** PULSE WIDTH MOD: how far the width moves from 50 % toward a sliver (p.26 §11: 30 µs). */
    pwm: p['pwm'] * 0.48,
    pwmSource: stepIndex(p['pwmSource'], 3), // 0 LFO, 1 MANUAL, 2 ENV-1
    /** CROSS MOD: VCO-2 into VCO-1's exponential FM; 5 on the scale is ±3 octaves (p.26 §10). */
    crossMod: p['crossMod'] * 7200,
    oct1: RANGE_OCT[stepIndex(p['range1'], 6)],
    wave1: stepIndex(p['wave1'], 4), // TRIANGLE, SAW, PULSE, SQUARE
    sync: on(p['sync']),
    lowFreq: on(p['lowFreq']),
    oct2: RANGE_OCT[stepIndex(p['range2'], 6)],
    fine2: (p['fine2'] * 2 - 1) * 50, // ±50 cent (spec)
    wave2: stepIndex(p['wave2'], 4), // SINE, SAW, PULSE, NOISE
    /** SOURCE MIX: VCO-1 alone fully left, VCO-2 alone fully right, both at full in the middle. */
    mix1: Math.min(1, 2 - 2 * p['sourceMix']),
    mix2: Math.min(1, 2 * p['sourceMix']),
    hpf: expMap(p['hpf'], 10, 3000),
    cutoff: expMap(p['cutoff'], 15, 20000),
    /** RES: the four-pole loop's feedback; 4 is the edge of self-oscillation. */
    res: p['res'] * 4.15,
    slope24: on(p['slope']),
    vcfEnv: p['vcfEnv'] * 7200,
    vcfEnv2: on(p['vcfEnvSel']),
    vcfLfo: p['vcfLfo'] * p['vcfLfo'] * 2400,
    keyFollow: p['keyFollow'] * 1.2, // 0–120 % (spec)
    level: p['level'],
    /** VCA LFO MOD, the four-position switch: tremolo depth. */
    vcaLfo: [0, 0.15, 0.3, 0.5][stepIndex(p['vcaLfo'], 4)],
    env1: envelope(p, 'env1'),
    env1Kf: on(p['env1Kf']),
    env1Neg: on(p['env1Pol']),
    env2: envelope(p, 'env2'),
    env2Kf: on(p['env2Kf']),
    tune: ((p['tune'] ?? 0.5) * 2 - 1) * 50,
    portaTime: on(p['porta']) && p['portaTime'] >= 0.01 ? time(p['portaTime'], 0.005, 4) : 0,
    /** Bender: up to ±an octave on the VCOs and ±4 octaves on the VCF, through its switches. */
    bendVco1: on(p['bendVco1']) ? p['bendVco'] * 1200 : 0,
    bendVco2: on(p['bendVco2']) ? p['bendVco'] * 1200 : 0,
    bendVcf: on(p['bendVcfOn']) ? p['bendVcf'] * 4800 : 0,
    /** LFO MODULATION (the lever pushed forward): vibrato and wah depths, in cents. */
    lfoModVco: p['lfoModVco'] * p['lfoModVco'] * 600,
    lfoModVcf: p['lfoModVcf'] * p['lfoModVcf'] * 2400,
  };
}

/** ENV-1 / ENV-2 sliders: attack 1 ms–5 s, decay and release 1 ms–10 s (spec). */
function envelope(p: Params, id: string) {
  return {
    a: time(p[id + 'A'], 0.001, 5),
    d: time(p[id + 'D'], 0.001, 10),
    s: p[id + 'S'],
    r: time(p[id + 'R'], 0.001, 10),
  };
}

export type Jupiter8Settings = ReturnType<typeof jupiter8Settings>;

/** Seconds per arpeggio step: the RATE slider on INT, the tempo's note value on EXT. */
export const arpPeriod = (s: Jupiter8Settings, bpm: number) =>
  s.arpExt ? (60 / bpm) * DIVISION_BEATS[s.arpDivision] : 1 / s.arpHz;

/**
 * ENV KEY FOLLOW: higher keys run the envelope faster (the module controller's ENV KF clock,
 * p.11); here the times halve every two octaves above middle C and double below.
 */
export const envKeyScale = (note: number) => Math.pow(2, -(note - 60) / 24);

/**
 * The arpeggio's notes over RANGE octaves: UP lowest to highest, DOWN back, U&D up then down
 * without repeating the ends, RANDOM the same set (the clock picks from it).
 */
export function arpeggio(held: number[], mode: ArpMode, range: number): number[] {
  const keys = [...new Set(held)].sort((a, b) => a - b);
  const up = Array.from({ length: range }, (_, o) => keys.map((n) => n + 12 * o)).flat();
  if (mode === 'up' || mode === 'random') return up;
  if (mode === 'down') return up.slice().reverse();
  if (mode === 'updown') return up.length > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
  return [];
}

// ── Key assigner ────────────────────────────────────────

/** What the assigner asks of a voice: start (or retarget) it on a note, or let it go. */
export type VoiceAction =
  { type: 'on'; voice: number; note: number; retrigger: boolean } | { type: 'off'; voice: number };

interface VoiceSlot {
  note: number | null;
  gate: boolean;
  /** When it last changed (a counter): oldest gate is stolen first, longest-free reused first. */
  age: number;
}

/**
 * The CPU's key assigner, for the four ASSIGN MODEs:
 * - SOLO: one voice, last-note priority; a new key retriggers, going back to a held one glides
 *   there without retriggering.
 * - UNISON: the same on all eight voices at once.
 * - POLY 1: keys take the voices in turn, so the last notes' releases ring on.
 * - POLY 2: a key goes back to the voice that last played it if that's free, else to the voice
 *   free the longest.
 * With every voice busy, the oldest note gives up its voice.
 */
export class Jp8Assigner {
  readonly voices: VoiceSlot[];
  private mode: Assign = 'poly2';
  private held: number[] = [];
  private clock = 0;
  private next = 0;

  constructor(n = VOICES) {
    this.voices = Array.from({ length: n }, () => ({ note: null, gate: false, age: 0 }));
  }

  setMode(mode: Assign): VoiceAction[] {
    if (mode === this.mode) return [];
    const off = this.releaseAll();
    this.mode = mode;
    return off;
  }

  /** Voices the mono modes use. */
  private mono(): number[] {
    return this.mode === 'solo' ? [0] : this.voices.map((_, i) => i);
  }

  press(note: number): VoiceAction[] {
    const t = ++this.clock;
    if (this.mode === 'solo' || this.mode === 'unison') {
      this.held = [...this.held.filter((n) => n !== note), note];
      return this.mono().map((voice) => this.start(voice, note, true, t));
    }
    // The same key again (HOLD, or a stolen voice's key) retriggers its own voice.
    const same = this.voices.findIndex((v) => v.gate && v.note === note);
    if (same >= 0) return [this.start(same, note, true, t)];
    return [this.start(this.pick(note), note, true, t)];
  }

  private pick(note: number): number {
    const free = this.voices.map((v, i) => i).filter((i) => !this.voices[i].gate);
    if (!free.length) return this.oldest(this.voices.map((_, i) => i));
    if (this.mode === 'poly1') {
      const n = this.voices.length;
      for (let k = 0; k < n; k++) {
        const i = (this.next + k) % n;
        if (!this.voices[i].gate) {
          this.next = (i + 1) % n;
          return i;
        }
      }
    }
    const own = free.find((i) => this.voices[i].note === note);
    return own ?? this.oldest(free);
  }

  private oldest(ids: number[]): number {
    return ids.reduce((a, b) => (this.voices[b].age < this.voices[a].age ? b : a));
  }

  private start(voice: number, note: number, retrigger: boolean, t: number): VoiceAction {
    const v = this.voices[voice];
    v.note = note;
    v.gate = true;
    v.age = t;
    return { type: 'on', voice, note, retrigger };
  }

  release(note: number): VoiceAction[] {
    const t = ++this.clock;
    if (this.mode === 'solo' || this.mode === 'unison') {
      const wasTop = this.held.at(-1) === note;
      this.held = this.held.filter((n) => n !== note);
      if (!wasTop) return [];
      const back = this.held.at(-1);
      if (back !== undefined) return this.mono().map((voice) => this.start(voice, back, false, t));
      return this.mono().map((voice) => this.stop(voice, t));
    }
    return this.voices
      .map((v, i) => (v.gate && v.note === note ? this.stop(i, t) : null))
      .filter((a): a is VoiceAction => a !== null);
  }

  private stop(voice: number, t: number): VoiceAction {
    this.voices[voice].gate = false;
    this.voices[voice].age = t;
    return { type: 'off', voice };
  }

  releaseAll(): VoiceAction[] {
    const t = ++this.clock;
    this.held = [];
    return this.voices
      .map((v, i) => (v.gate ? this.stop(i, t) : null))
      .filter((a): a is VoiceAction => a !== null);
  }

  /** Voices with a key down. */
  get busy(): number {
    return this.voices.filter((v) => v.gate).length;
  }
}

// ── Voice DSP ───────────────────────────────────────────

/** The numbers the DSP needs, from the settings (plain data: it crosses to the audio thread). */
export const dspParams = (s: Jupiter8Settings) => ({
  volume: s.volume,
  lfoRate: s.lfoRate,
  lfoDelay: s.lfoDelay,
  lfoWave: s.lfoWave,
  modLfo: s.modLfo,
  modEnv: s.modEnv,
  modVco1: s.modVco1,
  modVco2: s.modVco2,
  pwm: s.pwm,
  pwmSource: s.pwmSource,
  crossMod: s.crossMod,
  oct1: s.oct1,
  wave1: s.wave1,
  sync: s.sync,
  lowFreq: s.lowFreq,
  oct2: s.oct2,
  fine2: s.fine2,
  wave2: s.wave2,
  mix1: s.mix1,
  mix2: s.mix2,
  hpf: s.hpf,
  cutoff: s.cutoff,
  res: s.res,
  slope24: s.slope24,
  vcfEnv: s.vcfEnv,
  vcfEnv2: s.vcfEnv2,
  vcfLfo: s.vcfLfo,
  keyFollow: s.keyFollow,
  level: s.level,
  vcaLfo: s.vcaLfo,
  env1: s.env1,
  env1Kf: s.env1Kf,
  env1Neg: s.env1Neg,
  env2: s.env2,
  env2Kf: s.env2Kf,
  tune: s.tune,
  portaTime: s.portaTime,
  bendVco1: s.bendVco1,
  bendVco2: s.bendVco2,
  bendVcf: s.bendVcf,
  lfoModVco: s.lfoModVco,
  lfoModVcf: s.lfoModVcf,
  unison: s.assign === 'unison',
});

export type DspParams = ReturnType<typeof dspParams>;

/** A message to the DSP. `time` is in AudioContext seconds; events in the past apply at once. */
export type DspEvent =
  | { type: 'on'; time: number; voice: number; note: number; retrigger: boolean }
  | { type: 'off'; time: number; voice: number }
  | { type: 'allOff'; time: number };

/**
 * All eight voices, sample by sample. It runs on the audio thread: the unit sends its source to
 * an AudioWorklet (`Jupiter8Dsp.toString()`), so the class must stand alone: no imports, no
 * module constants, no class field initialisers (a bundler may rewrite those with helpers).
 *
 * Per voice: VCO-1 (polyBLEP saw / pulse / square, triangle) with exponential CROSS MOD from
 * VCO-2's last sample; VCO-2 (sine, saw, pulse, the shared noise; hard SYNC to VCO-1; LOW FREQ);
 * SOURCE MIX; a one-pole HPF; a four-pole ladder solved without delay in its loop, its input
 * soft-clipped, 12 dB from the second pole, 24 dB from the fourth; the VCA under ENV-2.
 * Modulation (LFO, ENV-1, glide, filter coefficients) updates every CONTROL samples; ENV-2 and
 * the audio run every sample. Silent voices are skipped.
 */
export class Jupiter8Dsp {
  sr: number;
  p: DspParams | null;
  voices: {
    note: number;
    pitch: number;
    gate: boolean;
    active: boolean;
    e1: number;
    st1: number;
    e2: number;
    st2: number;
    p1: number;
    p2: number;
    out2: number;
    dt1: number;
    dt2: number;
    pw: number;
    nz: number;
    hpX: number;
    hpY: number;
    s1: number;
    s2: number;
    s3: number;
    s4: number;
    g: number;
    gain: number;
    detune: number;
    c1: number[];
    c2: number[];
  }[];
  events: DspEvent[];
  lfoPhase: number;
  lfo: number;
  lfoHeld: number;
  lfoFade: number;
  bend: number;
  push: number;
  pushTarget: number;
  seed: number;
  count: number;
  hpA: number;
  sm: { cut: number; res: number; level: number; m1: number; m2: number };
  control: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.p = null;
    this.voices = [];
    for (let i = 0; i < 8; i++) {
      this.voices.push({
        note: 60,
        pitch: 60,
        gate: false,
        active: false,
        e1: 0,
        st1: 0,
        e2: 0,
        st2: 0,
        p1: Math.random(),
        p2: Math.random(),
        out2: 0,
        dt1: 0,
        dt2: 0,
        pw: 0.5,
        nz: 0,
        hpX: 0,
        hpY: 0,
        s1: 0,
        s2: 0,
        s3: 0,
        s4: 0,
        g: 0.5,
        gain: 0,
        // Unison spreads the voices a few cents apart, as eight free-running VCOs are.
        detune: ((i - 3.5) / 3.5) * 0.07,
        c1: [0, 0, 0, 1],
        c2: [0, 0, 0, 1],
      });
    }
    this.events = [];
    this.lfoPhase = 0;
    this.lfo = 0;
    this.lfoHeld = 0;
    this.lfoFade = 1;
    this.bend = 0;
    this.push = 0;
    this.pushTarget = 0;
    this.seed = 22222;
    this.count = 0;
    this.hpA = 1;
    this.sm = { cut: 0, res: 0, level: 0, m1: 0, m2: 0 };
    this.control = 8;
  }

  /** Messages from the unit: params, note events, bender, LFO MODULATION. */
  message(m: { type: string } & Record<string, unknown>) {
    if (m.type === 'params') {
      const first = !this.p;
      this.p = m['params'] as DspParams;
      if (first) {
        const p = this.p;
        this.sm = { cut: Math.log2(p.cutoff), res: p.res, level: p.level, m1: p.mix1, m2: p.mix2 };
      }
      for (const v of this.voices) this.coefs(v);
    } else if (m.type === 'bend') this.bend = m['value'] as number;
    else if (m.type === 'push') this.pushTarget = m['on'] ? 1 : 0;
    else {
      // Keep the queue in time order (the arpeggio sends its note-offs ahead of time).
      const e = m as unknown as DspEvent;
      let i = this.events.length;
      while (i > 0 && this.events[i - 1].time > e.time) i--;
      this.events.splice(i, 0, e);
    }
  }

  apply(e: DspEvent) {
    if (e.type === 'allOff') {
      for (const v of this.voices) this.gateOff(v);
      return;
    }
    const v = this.voices[e.voice];
    if (!v) return;
    if (e.type === 'off') {
      this.gateOff(v);
      return;
    }
    // LFO DELAY starts over when the first key goes down after all were up (the total gate).
    if (!this.voices.some((x) => x.gate)) this.lfoFade = 0;
    const glide = this.p && this.p.portaTime > 0 && v.active;
    v.note = e.note;
    if (!glide) v.pitch = e.note;
    if (!v.active) {
      v.s1 = v.s2 = v.s3 = v.s4 = 0;
      v.hpX = v.hpY = 0;
    }
    v.gate = true;
    v.active = true;
    if (e.retrigger || v.st2 === 3 || v.st2 === 0) {
      v.st1 = 1;
      v.st2 = 1;
    }
    this.coefs(v);
  }

  gateOff(v: Jupiter8Dsp['voices'][number]) {
    v.gate = false;
    if (v.st1) v.st1 = 3;
    if (v.st2) v.st2 = 3;
  }

  /** Per-sample envelope coefficients for a voice, with ENV KEY FOLLOW. */
  coefs(v: Jupiter8Dsp['voices'][number]) {
    const p = this.p;
    if (!p) return;
    const sr = this.sr;
    const k = Math.pow(2, -(v.note - 60) / 24);
    const set = (c: number[], e: DspParams['env1'], kf: boolean) => {
      const s = kf ? k : 1;
      // Attack charges toward 1.3 and stops at 1 (an RC aiming past its threshold); decay and
      // release fall to within 2 % in the set time.
      c[0] = 1 - Math.exp(-1 / (((e.a * s) / 1.466) * sr));
      c[1] = 1 - Math.exp(-1 / (((e.d * s) / 4) * sr));
      c[2] = 1 - Math.exp(-1 / (((e.r * s) / 4) * sr));
      c[3] = e.s;
    };
    set(v.c1, p.env1, p.env1Kf);
    set(v.c2, p.env2, p.env2Kf);
  }

  /** Renders a block into `out` (mono); `now` is the AudioContext time of its first sample. */
  render(out: Float32Array, now: number) {
    const n = out.length;
    out.fill(0);
    let pos = 0;
    while (pos < n) {
      let end = n;
      const e = this.events[0];
      if (e) {
        const at = Math.max(pos, Math.ceil((e.time - now) * this.sr));
        if (at < n) {
          end = at;
          if (end === pos) {
            this.apply(this.events.shift()!);
            continue;
          }
        }
      }
      this.run(out, pos, end);
      pos = end;
    }
  }

  /** One control step: LFO, smoothing, and every sounding voice's pitch, filter and width. */
  tick() {
    const p = this.p!;
    const dt = this.control / this.sr;
    // LFO: sine, falling saw (p.29 §21), square, random (a new level each cycle).
    this.lfoPhase += p.lfoRate * dt;
    if (this.lfoPhase >= 1) {
      this.lfoPhase -= Math.floor(this.lfoPhase);
      this.lfoHeld = this.noise();
    }
    const ph = this.lfoPhase;
    const w = p.lfoWave;
    const raw =
      w === 0
        ? Math.sin(2 * Math.PI * ph)
        : w === 1
          ? 1 - 2 * ph
          : w === 2
            ? ph < 0.5
              ? 1
              : -1
            : this.lfoHeld;
    this.lfoFade = p.lfoDelay > 0 ? Math.min(1, this.lfoFade + dt / p.lfoDelay) : 1;
    const lfo = (this.lfo = raw * this.lfoFade);
    this.push += (this.pushTarget - this.push) * 0.02;

    // Smooth the knobs that would zip.
    const sm = this.sm;
    sm.cut += (Math.log2(p.cutoff) - sm.cut) * 0.1;
    sm.res += (p.res - sm.res) * 0.1;
    sm.level += (p.level - sm.level) * 0.1;
    sm.m1 += (p.mix1 - sm.m1) * 0.1;
    sm.m2 += (p.mix2 - sm.m2) * 0.1;
    this.hpA = Math.exp((-2 * Math.PI * p.hpf) / this.sr);

    const glide = p.portaTime > 0 ? 1 - Math.exp(-dt / (p.portaTime / 3)) : 1;
    const vib = (lfo * p.lfoModVco * this.push) / 100;
    for (const v of this.voices) {
      if (!v.active) continue;
      v.pitch += (v.note - v.pitch) * glide;
      // ENV-1 runs at the control rate (it shapes pitch, cutoff and width).
      const c = v.c1;
      if (v.st1 === 1) {
        v.e1 += (1.3 - v.e1) * (1 - Math.pow(1 - c[0], this.control));
        if (v.e1 >= 1) {
          v.e1 = 1;
          v.st1 = 2;
        }
      } else if (v.st1 === 2) v.e1 += (c[3] - v.e1) * (1 - Math.pow(1 - c[1], this.control));
      else if (v.st1 === 3) v.e1 -= v.e1 * (1 - Math.pow(1 - c[2], this.control));
      const e1 = p.env1Neg ? -v.e1 : v.e1;

      const mod = (lfo * p.modLfo + e1 * p.modEnv) / 100;
      const uni = p.unison ? v.detune : 0;
      const base = v.pitch + p.tune / 100 + uni + vib;
      const n1 = base + 12 * p.oct1 + this.bend * (p.bendVco1 / 100) + (p.modVco1 ? mod : 0);
      let n2 = base + 12 * p.oct2 + p.fine2 / 100 + this.bend * (p.bendVco2 / 100);
      if (p.modVco2) n2 += mod;
      if (p.lowFreq) n2 -= 12 * 7;
      v.dt1 = Math.min(0.45, (440 * Math.pow(2, (n1 - 69) / 12)) / this.sr);
      v.dt2 = Math.min(0.45, (440 * Math.pow(2, (n2 - 69) / 12)) / this.sr);

      // PULSE WIDTH MOD: LFO swings it, MANUAL sets it, ENV-1 sweeps it.
      const amt = p.pwmSource === 0 ? 0.5 + 0.5 * lfo : p.pwmSource === 1 ? 1 : Math.abs(e1);
      v.pw = Math.max(0.02, Math.min(0.98, 0.5 - p.pwm * amt));

      // VCF: cutoff + ENV (ENV-1 or ENV-2) + LFO + KEY FOLLOW + bender + LFO MODULATION.
      const env = p.vcfEnv2 ? v.e2 : e1;
      const cents =
        env * p.vcfEnv +
        lfo * p.vcfLfo +
        (v.pitch - 60) * 100 * p.keyFollow +
        this.bend * p.bendVcf +
        lfo * p.lfoModVcf * this.push;
      const fc = Math.min(this.sr * 0.45, Math.pow(2, sm.cut + cents / 1200));
      v.g = Math.tan((Math.PI * fc) / this.sr);
      v.gain = sm.level * (1 + p.vcaLfo * lfo);
    }
  }

  /** The shared noise generator: one value per call, -1…1. */
  noise() {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed / 4294967296) * 2 - 1;
  }

  run(out: Float32Array, from: number, to: number) {
    const p = this.p;
    if (!p) return;
    const blep = (t: number, dt: number) => {
      if (t < dt) {
        t /= dt;
        return t + t - t * t - 1;
      }
      if (t > 1 - dt) {
        t = (t - 1) / dt;
        return t * t + t + t + 1;
      }
      return 0;
    };
    const sat = (x: number) => {
      const y = x > 3 ? 3 : x < -3 ? -3 : x;
      return (y * (27 + y * y)) / (27 + 9 * y * y);
    };
    const xm = p.crossMod / 1200;
    const k = this.sm.res;
    const comp = 1 + 0.35 * k;
    const out24 = p.slope24;
    const master = p.volume * (p.unison ? 0.5 : 1);
    const noiseOn = p.wave2 === 3;
    for (let i = from; i < to; i++) {
      if (--this.count <= 0) {
        this.count = this.control;
        this.tick();
      }
      const nz = noiseOn ? this.noise() : 0;
      let sum = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        // ENV-2 → VCA, every sample.
        const c = v.c2;
        if (v.st2 === 1) {
          v.e2 += (1.3 - v.e2) * c[0];
          if (v.e2 >= 1) {
            v.e2 = 1;
            v.st2 = 2;
          }
        } else if (v.st2 === 2) v.e2 += (c[3] - v.e2) * c[1];
        else if (v.st2 === 3) {
          v.e2 -= v.e2 * c[2];
          if (v.e2 < 1e-4 && !v.gate) {
            v.e2 = 0;
            v.st2 = 0;
            v.st1 = 0;
            v.e1 = 0;
            v.active = false;
            continue;
          }
        }

        // VCO-1, its pitch pushed by VCO-2's last sample (CROSS MOD).
        const dt1 = xm ? Math.min(0.45, v.dt1 * Math.pow(2, v.out2 * xm)) : v.dt1;
        let p1 = v.p1 + dt1;
        const wrapped = p1 >= 1;
        if (wrapped) p1 -= 1;
        v.p1 = p1;
        let o1: number;
        const w1 = p.wave1;
        if (w1 === 0) o1 = 1 - 4 * Math.abs(p1 - 0.5);
        else if (w1 === 1) o1 = 2 * p1 - 1 - blep(p1, dt1);
        else {
          const pw = w1 === 3 ? 0.5 : v.pw;
          o1 = (p1 < pw ? 1 : -1) + blep(p1, dt1) - blep((p1 + 1 - pw) % 1, dt1);
        }

        // VCO-2: SYNC restarts it with VCO-1's cycle.
        const dt2 = v.dt2;
        let p2 = v.p2 + dt2;
        if (p.sync && wrapped) p2 = (p1 / dt1) * dt2;
        if (p2 >= 1) p2 -= Math.floor(p2);
        v.p2 = p2;
        let o2: number;
        const w2 = p.wave2;
        if (w2 === 0) o2 = Math.sin(2 * Math.PI * p2);
        else if (w2 === 1) o2 = 2 * p2 - 1 - blep(p2, dt2);
        else if (w2 === 2)
          o2 = (p2 < v.pw ? 1 : -1) + blep(p2, dt2) - blep((p2 + 1 - v.pw) % 1, dt2);
        else if (p.lowFreq) {
          // LOW FREQ noise is slow and wandering (p.29 §24).
          v.nz += (nz - v.nz) * 0.004;
          o2 = v.nz * 6;
        } else o2 = nz;
        v.out2 = o2;

        // SOURCE MIX → HPF (one pole, no resonance).
        const x = o1 * this.sm.m1 + o2 * this.sm.m2;
        const hp = (v.hpY = this.hpA * (v.hpY + x - v.hpX));
        v.hpX = x;

        // VCF: four TPT one-poles, the loop solved for this sample, its input soft-clipped.
        const G = v.g / (1 + v.g);
        const b = 1 - G;
        const S = b * (G * G * G * v.s1 + G * G * v.s2 + G * v.s3 + v.s4);
        const G4 = G * G * G * G;
        const y4est = (G4 * hp * 0.5 + S) / (1 + k * G4);
        const u = sat(hp * 0.5 - k * y4est);
        let t = (u - v.s1) * G;
        const y1 = t + v.s1;
        v.s1 = y1 + t;
        t = (y1 - v.s2) * G;
        const y2 = t + v.s2;
        v.s2 = y2 + t;
        t = (y2 - v.s3) * G;
        const y3 = t + v.s3;
        v.s3 = y3 + t;
        t = (y3 - v.s4) * G;
        const y4 = t + v.s4;
        v.s4 = y4 + t;

        sum += (out24 ? y4 : y2) * comp * v.e2 * v.gain;
      }
      out[i] = sum * master;
    }
  }
}
