// JX-3P maths (1983), after the JX-3P / PG-200 service notes (first edition, July 1983): specs,
// front panel and PG-200 panel pp.1–2, block diagram p.4, waveforms switching chart p.5, circuit
// descriptions pp.6–7 (CPU program, voice assigner, DCO, SYNC / METAL, VCF, VCA, chorus,
// sequencer clock), MIDI implementation p.20. Page numbers are the PDF's. Interpretation notes in
// docs/devices/jx3p.md.
//
// Six voices, each: DCO-1 + DCO-2 (programmable counters off one master clock, their rectangles
// integrated into sawtooths) → MIXER (balance) → 4-pole VCF with resonance → VCA; then all six
// → MIXER → HPF → stereo BBD chorus → OUT. The CPU makes the envelopes and the LFO in software
// and assigns keys to voices. All of that (DCOs, envelopes, LFO, VCF, VCA, assigner) runs per
// sample in `Jx3pVoices`, which the unit loads into an AudioWorklet as source text, so the class
// must stay self-contained: no references to anything outside its own body.

import { type GearDef, noteJacks, p, sel } from './gear-types.ts';
import { expMap } from './sound.ts';
import { stepIndex } from './synth.ts';

type Params = Record<string, number>;

/** RANGE 16' / 8' / 4' against 8'. */
export const RANGE_RATIO = [0.5, 1, 2];
export const RANGES = ["16'", "8'", "4'"];
/** DCO-1 WAVEFORM (PG-200 ②); DCO-2 adds NOISE (㉚, and the switching chart p.5). */
export type Wave = 'saw' | 'pulse' | 'square' | 'noise';
export const DCO1_WAVES: Wave[] = ['saw', 'pulse', 'square'];
export const DCO2_WAVES: Wave[] = ['saw', 'pulse', 'square', 'noise'];
export const WAVE_LABELS = ['SAW', 'PULSE', 'SQUARE', 'NOISE'];
/** CROSS MOD (PG-200 ④): OFF, SYNC, METAL. */
export type CrossMod = 'off' | 'sync' | 'metal';
export const CROSS_MODS: CrossMod[] = ['off', 'sync', 'metal'];
export type LfoWave = 'sine' | 'square' | 'random';
export const LFO_WAVES: LfoWave[] = ['sine', 'square', 'random'];
/** BENDER RANGE switch: NARROW / MIDDLE / WIDE, ±2 / ±4 / ±7 semitones (MIDI notes, p.20). */
export const BEND_RANGES = [2, 4, 7];
/** Sequencer RATE: the step as a fraction of a beat at the song tempo (our choice). */
export const SEQ_RATES = [1 / 8, 1 / 4, 1 / 2, 1];
export const SEQ_RATE_LABELS = ['1/32', '1/16', '1/8', '1/4'];

export const VOICES = 6;
/** The sequencer's memory: 128 steps. */
export const SEQ_STEPS = 128;
/** Sequencer notes get their own ids in the voice assigner, apart from the keys'. */
export const SEQ_ID = 1000;
/**
 * The pulse: with PULSE selected the CPU drives the DCO CV to its top (S/H OUT = 5 V on the
 * switching chart, p.5), so the integrator ramps at a fixed, steep rate and clips: a "pulse-like
 * sawtooth" whose width is a fixed time, ~0.5 ms here (our reading of the chart).
 */
export const PULSE_TIME = 0.0005;

const OFF_ON = ['OFF', 'ON'];
const time = (v: number, min: number, max: number) => expMap(v, min, max);
const bipolar = (v: number) => v * 2 - 1;

// JX-3P (1983): six voices of two DCOs → 4-pole VCF → VCA, one HPF and a stereo chorus for all,
// with the PG-200 programmer's controls on the panel and the 128-step polyphonic sequencer.
export const JX3P_GEAR: GearDef = {
  kind: 'jx3p',
  label: 'JX-3P',
  category: 'synth',
  w: 26,
  h: 10,
  // The rear jack strip along the top edge: NOTE IN / OUT, then OUTPUT at the right.
  jacks: [
    ...noteJacks([0.89, 0.025], [0.925, 0.025]),
    { id: 'out', dir: 'out', fx: 0.975, fy: 0.025, label: 'OUTPUT' },
  ],
  params: [
    // PG-200: DCO-1
    sel('dco1Range', 'DCO-1 RANGE', RANGES, 1),
    sel('dco1Wave', 'DCO-1 WAVEFORM', WAVE_LABELS.slice(0, 3), 0),
    sel('dco1Lfo', 'DCO-1 FREQ MOD LFO', OFF_ON, 0),
    sel('dco1Env', 'DCO-1 FREQ MOD ENV', OFF_ON, 0),
    // DCO-2
    sel('dco2Range', 'DCO-2 RANGE', RANGES, 1),
    sel('dco2Wave', 'DCO-2 WAVEFORM', WAVE_LABELS, 0),
    sel('crossMod', 'CROSS MOD', ['OFF', 'SYNC', 'METAL'], 0),
    { ...p('dco2Tune', 'DCO-2 TUNE', 0.5), steps: 25 },
    { ...p('dco2Fine', 'DCO-2 FINE TUNE', 0.56), bipolar: true },
    sel('dco2Lfo', 'DCO-2 FREQ MOD LFO', OFF_ON, 0),
    sel('dco2Env', 'DCO-2 FREQ MOD ENV', OFF_ON, 0),
    // Frequency modulation depths (shared), ENV polarity
    p('lfoDepth', 'LFO DEPTH', 0.3),
    p('envDepth', 'ENV DEPTH', 0.4),
    sel('envPolarity', 'DCO ENV POLARITY', ['NORMAL', 'INVERT'], 0),
    // VCF
    p('mix', 'SOURCE MIX', 0.5),
    p('hpf', 'HPF', 0),
    p('cutoff', 'CUTOFF FREQ', 0.55),
    p('resonance', 'RESONANCE', 0.15),
    p('vcfLfo', 'VCF LFO MOD', 0),
    p('vcfEnv', 'VCF ENV MOD', 0.35),
    sel('vcfPolarity', 'VCF ENV POLARITY', ['NORMAL', 'INVERT'], 0),
    p('pitchFollow', 'PITCH FOLLOW', 0.5),
    // VCA, chorus
    sel('vcaMode', 'VCA MODE', ['ENV', 'GATE'], 0),
    p('vcaLevel', 'VCA LEVEL', 0.75),
    sel('chorus', 'CHORUS', OFF_ON, 1),
    // LFO, envelope
    sel('lfoWave', 'LFO WAVEFORM', ['SINE', 'SQUARE', 'RANDOM'], 0),
    p('lfoDelay', 'LFO DELAY TIME', 0),
    p('lfoRate', 'LFO RATE', 0.5),
    p('attack', 'ATTACK', 0.08),
    p('decay', 'DECAY', 0.5),
    p('sustain', 'SUSTAIN', 0.65),
    p('release', 'RELEASE', 0.4),
    // The JX-3P's own face
    bipolarParam('brilliance', 'BRILLIANCE'),
    p('volume', 'VOLUME', 0.7),
    sel('benderRange', 'BENDER RANGE', ['NARROW', 'MIDDLE', 'WIDE'], 0),
    sel('mute', 'MUTE', OFF_ON, 0),
    sel('hold', 'HOLD', OFF_ON, 0),
    sel('keyTranspose', 'KEY TRANSPOSE', OFF_ON, 0),
    { ...p('lfoTrig', 'LFO TRIG', 0), action: 'lfoTrig' },
    sel('seqWrite', 'SEQUENCER WRITE', OFF_ON, 0),
    sel('seqPlay', 'START / STOP', OFF_ON, 0),
    sel('seqRate', 'SEQUENCER RATE', SEQ_RATE_LABELS, 1),
    { ...p('tie', 'TIE', 0), action: 'tie' },
    { ...p('rest', 'REST', 0), action: 'rest' },
  ],
  // The panel is its own component (gear/jx3p-panel). 61 keys, C to C (spec, p.1).
  keyboard: { from: -12, keys: 61 },
};

function bipolarParam(id: string, label: string) {
  return { ...p(id, label, 0.5), bipolar: true };
}

export function jx3pSettings(p: Params) {
  const on = (id: string) => (p[id] ?? 0) >= 0.5;
  return {
    dco1Ratio: RANGE_RATIO[stepIndex(p['dco1Range'], 3)],
    dco1Wave: DCO1_WAVES[stepIndex(p['dco1Wave'], 3)],
    dco1Lfo: on('dco1Lfo'),
    dco1Env: on('dco1Env'),
    dco2Ratio: RANGE_RATIO[stepIndex(p['dco2Range'], 3)],
    dco2Wave: DCO2_WAVES[stepIndex(p['dco2Wave'], 4)],
    crossMod: CROSS_MODS[stepIndex(p['crossMod'], 3)],
    /** DCO-2 TUNE in semitones (±1 octave; the CPU adds it to DCO-2's divisor, p.6). */
    dco2Semis: stepIndex(p['dco2Tune'], 25) - 12,
    dco2Fine: bipolar(p['dco2Fine']) * 50, // cents
    dco2Lfo: on('dco2Lfo'),
    dco2Env: on('dco2Env'),
    /** Frequency modulation depths in cents: LFO up to ±1 octave, ENV up to 3 octaves. */
    lfoDepth: p['lfoDepth'] * p['lfoDepth'] * 1200,
    envDepth: p['envDepth'] * p['envDepth'] * 3600 * (on('envPolarity') ? -1 : 1),
    /** SOURCE MIX: 0 = DCO-1 only, 1 = DCO-2 only (the mixer's BAL voltage, p.4). */
    mix: p['mix'],
    /** HPF after the six voices are mixed (block diagram); fully left is out of the way. */
    hpf: p['hpf'] < 0.01 ? 5 : expMap(p['hpf'], 40, 1500),
    cutoff: expMap(p['cutoff'], 15, 18000),
    /** Feedback around the 4-pole VCF: it self-oscillates at the top (adjustment 5, p.7). */
    resonance: p['resonance'] * 4.2,
    vcfLfo: p['vcfLfo'] * p['vcfLfo'] * 3600, // cents
    vcfEnv: p['vcfEnv'] * 8400 * (on('vcfPolarity') ? -1 : 1), // cents, up to 7 octaves
    pitchFollow: p['pitchFollow'], // 0–100 %
    vcaGate: on('vcaMode'),
    vcaLevel: p['vcaLevel'],
    chorus: on('chorus'),
    lfoWave: LFO_WAVES[stepIndex(p['lfoWave'], 3)],
    lfoDelay: p['lfoDelay'] < 0.01 ? 0 : time(p['lfoDelay'], 0.05, 5),
    lfoRate: expMap(p['lfoRate'], 0.1, 20),
    attack: time(p['attack'], 0.001, 5),
    decay: time(p['decay'], 0.002, 10),
    sustain: p['sustain'],
    release: time(p['release'], 0.002, 10),
    /** BRILLIANCE: the face slider that shifts every voice's cutoff, ±1½ octaves (cents). */
    brilliance: bipolar(p['brilliance'] ?? 0.5) * 1800,
    volume: p['volume'] * p['volume'],
    bendRange: BEND_RANGES[stepIndex(p['benderRange'], 3)],
    mute: on('mute'),
    hold: on('hold'),
    keyTranspose: on('keyTranspose'),
    seqWrite: on('seqWrite'),
    seqPlay: on('seqPlay'),
    /** Beats per sequencer step. */
    seqRate: SEQ_RATES[stepIndex(p['seqRate'], 4)],
  };
}

export type Jx3pSettings = ReturnType<typeof jx3pSettings>;

// ── Sequencer ───────────────────────────────────────────

/** A step: the notes keyed together (a chord, a note, or none for a REST), or a TIE. */
export type SeqStep = number[] | 'tie';

/** WRITE appends steps up to the 128-step memory. */
export const addStep = (seq: SeqStep[], step: SeqStep): SeqStep[] =>
  seq.length >= SEQ_STEPS ? seq : [...seq, step];

/**
 * What step `i` plays: its notes (moved by the key transpose) and how many steps they last, a
 * chord running on through the TIEs after it. A REST, or a TIE (the notes it extends were started
 * earlier), starts nothing.
 */
export function stepAt(
  seq: SeqStep[],
  i: number,
  transpose = 0,
): { notes: number[]; steps: number } {
  const s = seq[i];
  if (!s || s === 'tie' || !s.length) return { notes: [], steps: 1 };
  let steps = 1;
  while (seq[i + steps] === 'tie') steps++;
  return { notes: s.map((n) => n + transpose), steps };
}

/**
 * The sequence as text for the patch: steps separated by spaces, each a chord of two-digit hex
 * note numbers, `.` for a rest, `-` for a tie. It is split into `seq0`, `seq1`… since one text
 * setting holds 500 characters.
 */
export function encodeSequence(seq: SeqStep[]): string {
  return seq
    .map((s) =>
      s === 'tie' ? '-' : s.length ? s.map((n) => n.toString(16).padStart(2, '0')).join('') : '.',
    )
    .join(' ');
}

export function decodeSequence(text: string): SeqStep[] {
  const out: SeqStep[] = [];
  for (const w of text.split(' ')) {
    if (!w) continue;
    if (w === '-') out.push('tie');
    else if (w === '.') out.push([]);
    else if (/^([0-9a-f]{2})+$/.test(w)) out.push(w.match(/../g)!.map((h) => parseInt(h, 16)));
    if (out.length >= SEQ_STEPS) break;
  }
  return out;
}

export const SEQ_CHUNK = 480;
/** Enough chunks for 128 six-note chords. */
export const SEQ_KEYS = ['seq0', 'seq1', 'seq2', 'seq3', 'seq4', 'seq5'];

/** Splits the encoded sequence over the text keys (empty strings clear the unused ones). */
export function sequenceChunks(seq: SeqStep[]): Record<string, string> {
  const text = encodeSequence(seq);
  return Object.fromEntries(
    SEQ_KEYS.map((k, i) => [k, text.slice(i * SEQ_CHUNK, (i + 1) * SEQ_CHUNK)]),
  );
}

export const sequenceFromText = (text: Record<string, string>): SeqStep[] =>
  decodeSequence(SEQ_KEYS.map((k) => text[k] ?? '').join(''));

// ── The voices (runs inside the AudioWorklet) ───────────

/**
 * Settings the voices need, as sent to the worklet (the plain fields of `Jx3pSettings`).
 */
export type VoiceSettings = Pick<
  Jx3pSettings,
  | 'dco1Ratio'
  | 'dco1Wave'
  | 'dco1Lfo'
  | 'dco1Env'
  | 'dco2Ratio'
  | 'dco2Wave'
  | 'crossMod'
  | 'dco2Semis'
  | 'dco2Fine'
  | 'dco2Lfo'
  | 'dco2Env'
  | 'lfoDepth'
  | 'envDepth'
  | 'mix'
  | 'cutoff'
  | 'resonance'
  | 'vcfLfo'
  | 'vcfEnv'
  | 'pitchFollow'
  | 'vcaGate'
  | 'vcaLevel'
  | 'lfoWave'
  | 'lfoDelay'
  | 'lfoRate'
  | 'attack'
  | 'decay'
  | 'sustain'
  | 'release'
  | 'brilliance'
  | 'mute'
  | 'bendRange'
>;

export interface VoiceEvent {
  type: 'on' | 'off' | 'all' | 'bend' | 'params' | 'lfoTrig' | 'seqStop';
  id?: number;
  note?: number;
  value?: number;
  settings?: VoiceSettings;
}

interface Voice {
  /** The key (or sequencer note) it is assigned to, -1 when it never was. */
  id: number;
  note: number;
  gate: boolean;
  /** When it was keyed / released, in assigner events, for picking which voice to take. */
  onAt: number;
  offAt: number;
  // Envelope: 0 idle, 1 attack, 2 decay / sustain, 3 release; GATE-mode level.
  stage: number;
  env: number;
  gateLevel: number;
  // DCO-1 counter phase; DCO-2 counter phase and its integrator ramp.
  p1: number;
  p2: number;
  r2: number;
  /** The previous sample (output one sample late, so PolyBLEP can correct both sides of an edge). */
  last: number;
  dcIn: number;
  dcOut: number;
  /** VCF: the four integrator states and the last block's coefficient. */
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  g: number;
}

/**
 * Six voices, the software LFO and the key assigner. Self-contained (see the header): it is also
 * the worklet's code.
 */
export class Jx3pVoices {
  sr: number;
  s: VoiceSettings | null = null;
  voices: Voice[] = [];
  /** Assigner clock: one tick per key event. */
  clock = 0;
  bend = 0;
  lfoPhase = 0;
  lfoValue = 0;
  lfoRandom = 0;
  /** LFO delay: seconds since it was triggered (it fades in over the DELAY TIME). */
  lfoAge = 1e9;
  // Envelope coefficients per sample
  atk = 1;
  dec = 0;
  rel = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    for (let i = 0; i < 6; i++) {
      this.voices.push({
        id: -1,
        note: 60,
        gate: false,
        onAt: -1,
        offAt: -1,
        stage: 0,
        env: 0,
        gateLevel: 0,
        p1: 0,
        p2: 0,
        r2: 0,
        last: 0,
        dcIn: 0,
        dcOut: 0,
        s1: 0,
        s2: 0,
        s3: 0,
        s4: 0,
        g: 0,
      });
    }
  }

  handle(e: VoiceEvent) {
    if (e.type === 'params' && e.settings) this.setSettings(e.settings);
    else if (e.type === 'on') this.noteOn(e.id ?? 0, e.note ?? 60);
    else if (e.type === 'off') this.noteOff(e.id ?? 0);
    else if (e.type === 'all') for (const v of this.voices) this.release(v);
    else if (e.type === 'bend') this.bend = e.value ?? 0;
    else if (e.type === 'lfoTrig') this.lfoAge = 0;
    else if (e.type === 'seqStop') {
      for (const v of this.voices) if (v.id >= 1000) this.release(v);
    }
  }

  setSettings(s: VoiceSettings) {
    this.s = s;
    const sr = this.sr;
    this.atk = 1 / (s.attack * sr);
    // Exponential decay / release with time constants of a quarter of the knob's time.
    this.dec = Math.exp(-4 / (s.decay * sr));
    this.rel = Math.exp(-4 / (s.release * sr));
  }

  /**
   * The assigner (p.6): "Once the CPU has accepted a keypress, it glances over 6 modules to find
   * the most suitable module… The module is kept assigned until it is stolen by a new key." So a
   * key goes back to the voice it had; else to the voice released longest ago; else it steals the
   * voice keyed longest ago.
   */
  pick(id: number, note: number): Voice {
    const vs = this.voices;
    const same = vs.find((v) => v.id === id) ?? vs.find((v) => !v.gate && v.note === note);
    if (same) return same;
    let best: Voice | null = null;
    for (const v of vs) if (!v.gate && (!best || v.offAt < best.offAt)) best = v;
    if (best) return best;
    for (const v of vs) if (!best || v.onAt < best.onAt) best = v;
    return best!;
  }

  noteOn(id: number, note: number) {
    // The LFO's delay starts again on the first key down (single trigger).
    if (!this.voices.some((v) => v.gate)) this.lfoAge = 0;
    const v = this.pick(id, note);
    if (v.note !== note) {
      // A fresh key for this voice: its counters start together, as the CPU loads them.
      v.p1 = 0;
      v.p2 = 0;
      v.r2 = 0;
    }
    v.id = id;
    v.note = note;
    v.gate = true;
    v.onAt = this.clock++;
    v.stage = 1; // attack from wherever the envelope is
  }

  noteOff(id: number) {
    for (const v of this.voices) if (v.id === id && v.gate) this.release(v);
  }

  release(v: Voice) {
    if (!v.gate && v.stage !== 1 && v.stage !== 2) return;
    v.gate = false;
    v.offAt = this.clock++;
    if (v.stage !== 0) v.stage = 3;
  }

  /** Voices still sounding. */
  active(): number {
    let n = 0;
    for (const v of this.voices) if (v.stage !== 0 || v.gateLevel > 1e-4) n++;
    return n;
  }

  /**
   * Adds the voices into `out` from `start` to `end`. The LFO, the DCO pitches and the cutoff
   * targets are worked out once per call (the CPU refreshes them every program cycle, p.6); the
   * envelopes, DCOs and filters run per sample.
   */
  render(out: Float32Array, start: number, end: number) {
    const s = this.s;
    const n = end - start;
    if (!s || n <= 0) return;
    const sr = this.sr;
    const dt = n / sr;

    // LFO: sine, square or a new random level each cycle; faded in over the delay time.
    this.lfoPhase += s.lfoRate * dt;
    if (this.lfoPhase >= 1) {
      this.lfoPhase -= Math.floor(this.lfoPhase);
      this.lfoRandom = Math.random() * 2 - 1;
    }
    const ph = this.lfoPhase;
    const wave =
      s.lfoWave === 'sine'
        ? Math.sin(2 * Math.PI * ph)
        : s.lfoWave === 'square'
          ? ph < 0.5
            ? 1
            : -1
          : this.lfoRandom;
    this.lfoAge += dt;
    const fade = s.lfoDelay <= 0 ? 1 : Math.min(1, this.lfoAge / s.lfoDelay);
    const lfo = wave * fade;
    this.lfoValue = lfo;

    const bendCents = this.bend * s.bendRange * 100;
    const k = s.resonance;
    const g1 = 1 - s.mix;
    const g2 = s.mix;
    const dcR = 1 - (2 * Math.PI * 10) / sr;
    const gateCoef = 1 - Math.exp(-1 / (0.002 * sr));
    const level = s.mute ? 0 : s.vcaLevel;
    const maxF = sr * 0.45;

    for (const v of this.voices) {
      if (v.stage === 0 && v.gateLevel < 1e-4 && !v.gate) continue;
      // Pitches for this block (cents from the key), DCO CV: KCV, LFO, ADSR, BENDER (p.6).
      const m1 =
        bendCents + (s.dco1Lfo ? lfo * s.lfoDepth : 0) + (s.dco1Env ? v.env * s.envDepth : 0);
      const m2 =
        bendCents +
        s.dco2Semis * 100 +
        s.dco2Fine +
        (s.dco2Lfo ? lfo * s.lfoDepth : 0) +
        (s.dco2Env ? v.env * s.envDepth : 0);
      const key = 440 * Math.pow(2, (v.note - 69) / 12);
      const f1 = Math.min(maxF, key * s.dco1Ratio * Math.pow(2, m1 / 1200));
      const f2 = Math.min(maxF, key * s.dco2Ratio * Math.pow(2, m2 / 1200));
      const inc1 = f1 / sr;
      const inc2 = f2 / sr;
      // The pulse: the ramp clips after a fixed time, so its share of the cycle grows with pitch.
      const duty1 = s.dco1Wave === 'pulse' ? Math.min(1, 0.0005 * f1) : 1;
      const duty2 = s.dco2Wave === 'pulse' ? Math.min(1, 0.0005 * f2) : 1;
      const square1 = s.dco1Wave === 'square';
      const noise2 = s.dco2Wave === 'noise';
      const metal = s.crossMod === 'metal' && !noise2;
      const sync = s.crossMod === 'sync' && !noise2;
      // METAL: DCO-2's output can't gate through, only its ramp is heard (p.6 and chart p.5).
      const square2 = s.dco2Wave === 'square' && !metal;

      // VCF CV: KCV, ADSR, CUTOFF, LFO (p.6), plus BRILLIANCE; the coefficient glides over the block.
      const cents =
        s.pitchFollow * (v.note - 60) * 100 + v.env * s.vcfEnv + lfo * s.vcfLfo + s.brilliance;
      const fc = Math.max(8, Math.min(maxF, s.cutoff * Math.pow(2, cents / 1200)));
      const gEnd = Math.tan((Math.PI * fc) / sr);
      const gStart = v.g || gEnd;
      v.g = gEnd;
      const gStep = (gEnd - gStart) / n;
      const drive = 1 + 0.3 * k;

      let g = gStart;
      for (let i = start; i < end; i++) {
        // Envelope
        if (v.stage === 1) {
          v.env += this.atk;
          if (v.env >= 1) {
            v.env = 1;
            v.stage = 2;
          }
        } else if (v.stage === 2) v.env = s.sustain + (v.env - s.sustain) * this.dec;
        else if (v.stage === 3) {
          v.env *= this.rel;
          if (v.env < 1e-5) {
            v.env = 0;
            v.stage = 0;
          }
        }
        v.gateLevel += ((v.gate ? 1 : 0) - v.gateLevel) * gateCoef;

        // DCO-1: the counter's rectangle, or its integrated ramp (reset each cycle).
        let before = 0;
        let after = 0;
        const q1 = v.p1;
        let p1 = q1 + inc1;
        let wrap1 = -1;
        let fall1 = -1;
        if (p1 >= 1) {
          p1 -= 1;
          wrap1 = p1 / inc1;
        } else if (q1 < 0.5 && p1 >= 0.5) fall1 = (p1 - 0.5) / inc1;
        v.p1 = p1;
        let x1: number;
        if (square1) {
          x1 = p1 < 0.5 ? 1 : -1;
          if (wrap1 >= 0) {
            before += g1 * wrap1 * wrap1;
            after -= g1 * (1 - wrap1) * (1 - wrap1);
          } else if (fall1 >= 0) {
            before -= g1 * fall1 * fall1;
            after += g1 * (1 - fall1) * (1 - fall1);
          }
        } else {
          x1 = 1 - 2 * Math.min(1, p1 / duty1);
          if (wrap1 >= 0) {
            // jump of +2 from the ramp's end back to its start
            before += g1 * wrap1 * wrap1;
            after -= g1 * (1 - wrap1) * (1 - wrap1);
          }
        }

        // DCO-2
        let x2: number;
        if (noise2) x2 = Math.random() * 2 - 1;
        else {
          const q2 = v.p2;
          let p2 = q2 + inc2;
          let r2 = v.r2 + inc2;
          // Events this sample: [time since it, in samples; jump of the output]
          let wrap2 = -1;
          let fall2 = -1;
          if (p2 >= 1) {
            p2 -= 1;
            wrap2 = p2 / inc2;
          } else if (q2 < 0.5 && p2 >= 0.5) fall2 = (p2 - 0.5) / inc2;
          const rampJump = (r: number) => 2 * Math.min(1, r / duty2);
          if (sync && wrap1 >= 0) {
            // SYNC: DCO-1 resets DCO-2's counter (and its ramp) each cycle.
            const t = wrap1;
            const wasLow = p2 - t * inc2 >= 0.5 && wrap2 < 0;
            const h = square2 ? (wasLow ? 2 : 0) : rampJump(r2 - t * inc2);
            before += 0.5 * g2 * h * t * t;
            after -= 0.5 * g2 * h * (1 - t) * (1 - t);
            p2 = t * inc2;
            r2 = t * inc2;
            wrap2 = -1;
            fall2 = -1;
          } else if (metal) {
            // METAL: the ramp is discharged on every falling edge of both rectangles.
            const t = fall1 >= 0 ? fall1 : fall2;
            if (t >= 0) {
              const h = rampJump(r2 - t * inc2);
              before += 0.5 * g2 * h * t * t;
              after -= 0.5 * g2 * h * (1 - t) * (1 - t);
              r2 = t * inc2;
            }
          } else if (wrap2 >= 0) {
            const t = wrap2;
            const h = square2 ? 2 : rampJump(r2 - t * inc2);
            before += 0.5 * g2 * h * t * t;
            after -= 0.5 * g2 * h * (1 - t) * (1 - t);
            r2 = t * inc2;
          } else if (fall2 >= 0 && square2) {
            const t = fall2;
            before -= g2 * t * t;
            after += g2 * (1 - t) * (1 - t);
          }
          if (r2 > 4) r2 = 4;
          v.p2 = p2;
          v.r2 = r2;
          x2 = square2 ? (p2 < 0.5 ? 1 : -1) : 1 - 2 * Math.min(1, r2 / duty2);
        }

        // Mixer, one sample late with its edge corrections, then the coupling capacitor.
        const now = g1 * x1 + g2 * x2 + after;
        const mixed = v.last + before;
        v.last = now;
        const dc = mixed - v.dcIn + dcR * v.dcOut;
        v.dcIn = mixed;
        v.dcOut = dc;

        // VCF: four one-pole stages (TPT) with resonance feedback, the input soft-clipped.
        g += gStep;
        const G = g / (1 + g);
        const b = 1 / (1 + g);
        const S = b * (G * G * G * v.s1 + G * G * v.s2 + G * v.s3 + v.s4);
        const G4 = G * G * G * G;
        const x = dc * drive * 0.7;
        const y4 = (G4 * x + S) / (1 + k * G4);
        const u = Math.tanh(x - k * y4);
        let w = (u - v.s1) * G;
        let y = w + v.s1;
        v.s1 = y + w;
        w = (y - v.s2) * G;
        y = w + v.s2;
        v.s2 = y + w;
        w = (y - v.s3) * G;
        y = w + v.s3;
        v.s3 = y + w;
        w = (y - v.s4) * G;
        y = w + v.s4;
        v.s4 = y + w;

        // VCA: ENV or GATE, LEVEL, MUTE (p.7).
        out[i] += y * level * (s.vcaGate ? v.gateLevel : v.env);
      }
    }
  }
}
