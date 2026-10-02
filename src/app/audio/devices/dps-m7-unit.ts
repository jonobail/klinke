// DPS-M7 (manual p.11): INPUT → PRE-EFFECT → MODULATION → OUTPUT, with the ENVELOPE block
// following the input:
//
//   send → [pre-effect slot] ─┬→ direct ─────────────────────────────┬→ ret
//                             └→ [modulation slot] → effect level ───┘
//   send → envelope follower → ENV ───────────────↗ (effect modulation, p.18)
//
// Each modulation algorithm (pp.23–48) is built from the shared blocks in a crossfading slot.
// The direct / effect balance is the MIX knob; it lives here rather than in the base so the
// pre-effect reaches the direct sound too, as on the hardware.

import { type M7Algo, m7Settings } from '../../core/devices/dps-m7';
import { centsRatio, type Wave } from '../../core/devices/dps-dsp';
import { mixSends } from '../../core/sound';
import { type Params, glide } from '../unit';
import {
  AutoPan,
  type Block,
  Dynamics,
  Envelope,
  Eq3,
  Exciter,
  Gate,
  HaasPan,
  Phaser,
  PitchShift,
  RingMod,
  Rotary,
  Slot,
  Through,
  Tremolo,
  Voices,
} from './dps-blocks';
import { RackUnit } from './rack-unit';

type Settings = ReturnType<typeof m7Settings>;

interface Algo extends Block {
  set(s: Settings): void;
}

/** Chains blocks in series into one algorithm. */
function chain(ctx: BaseAudioContext, blocks: Block[], set: (s: Settings) => void): Algo {
  for (let i = 1; i < blocks.length; i++) blocks[i - 1].output.connect(blocks[i].input);
  return {
    input: blocks[0].input,
    output: blocks[blocks.length - 1].output,
    set,
    dispose: () => blocks.forEach((b) => b.dispose()),
  };
}

function band(ctx: BaseAudioContext, hz: number): Block {
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hz;
  return { input: f, output: f, dispose: () => f.disconnect() };
}

/** LFO-swept voices: depth 100 % swings the delay about 20 ms (M7 p.23). */
const CHORUS_SWING = 0.01;

function buildAlgo(ctx: BaseAudioContext, a: M7Algo): Algo {
  const chorus = (n: number, ensemble = false, rateR?: number) => {
    const v = new Voices(ctx, n, 1.05, ensemble);
    return chain(ctx, [v], (s) =>
      v.set({
        rateHz: s.rateHz,
        depth: s.depth * CHORUS_SWING,
        pre: s.delay,
        wave: s.wave as Wave,
        spread: s.phase,
        rateR,
      }),
    );
  };
  const flanger = (n: number, rateR?: number) => {
    const v = new Voices(ctx, n);
    // SFL p.36: "manual" sets the centre delay (up to ~20 ms), depth 100 % about 20 ms of sweep.
    return chain(ctx, [v], (s) =>
      v.set({
        rateHz: s.rateHz,
        depth: 0.0003 + s.depth * 0.005,
        pre: 0.0003 + s.delay,
        fb: s.feedback * 0.95,
        wave: s.wave as Wave,
        spread: s.phase,
        rateR,
      }),
    );
  };
  const pitch = (pre: Block[] = []) => {
    const l = new PitchShift(ctx, 0.55);
    const r = new PitchShift(ctx, 0.55);
    const input = ctx.createGain();
    const m = ctx.createChannelMerger(2);
    input.connect(l.input);
    input.connect(r.input);
    l.output.connect(m, 0, 0);
    r.output.connect(m, 0, 1);
    const pair: Block = {
      input,
      output: m,
      dispose: () => {
        l.dispose();
        r.dispose();
      },
    };
    return {
      blocks: [...pre, pair],
      set: (s: Settings, reverse = false) => {
        const ratio = centsRatio(s.pitch);
        const shift = {
          ratio: reverse ? -ratio : ratio,
          window: reverse ? 0.02 + s.delay : 0.06,
          pre: reverse ? 0 : s.delay,
          fb: Math.abs(s.feedback) * 0.9,
        };
        l.set(shift);
        // The ch2 shifter sits a touch later, for width.
        r.set({ ...shift, pre: shift.pre + 0.012 });
      },
    };
  };

  switch (a.code) {
    case 'SCH':
      return chorus(2);
    case 'DCH':
      return chorus(5);
    case 'MCH':
      return chorus(3, false, 1.33);
    case 'BCH': {
      const c = chorus(2);
      return chain(ctx, [band(ctx, 300), c], c.set);
    }
    case 'ENS':
      return chorus(3, true);
    case 'SPS': {
      const p = pitch();
      return chain(ctx, p.blocks, (s) => p.set(s));
    }
    case 'BPS': {
      const p = pitch([band(ctx, 400)]);
      return chain(ctx, p.blocks, (s) => p.set(s));
    }
    case 'PSM': {
      const p = pitch();
      const v = new Voices(ctx, 1, 0.05);
      return chain(ctx, [...p.blocks, v], (s) => {
        p.set(s);
        v.set({
          rateHz: s.rateHz,
          depth: s.depth * 0.004,
          pre: 0,
          wave: s.wave as Wave,
          spread: s.phase,
        });
      });
    }
    case 'RVS': {
      const p = pitch();
      return chain(ctx, p.blocks, (s) => p.set(s, true));
    }
    case 'MPH': {
      const ph = new Phaser(ctx, 8);
      return chain(ctx, [ph], (s) =>
        ph.set({
          rateHz: s.rateHz,
          depth: s.depth,
          manual: s.delayKnob,
          resonance: s.feedback,
          wave: s.wave as Wave,
          spread: s.phase,
        }),
      );
    }
    case 'SFL':
      return flanger(1);
    case 'MFL':
      return flanger(2, 1.5);
    case 'MDL': {
      const v = new Voices(ctx, 1, 0.55);
      return chain(ctx, [v], (s) =>
        v.set({
          rateHz: s.rateHz,
          depth: s.depth * 0.003,
          pre: s.delay,
          fb: s.feedback * 0.95,
          wave: s.wave as Wave,
          spread: s.phase,
          lpf: 8000,
        }),
      );
    }
    case 'SPM': {
      // Spiral: a chorus whose image circles round with the same LFO rate (interpretation).
      const v = new Voices(ctx, 2, 0.35);
      const pan = new AutoPan(ctx);
      return chain(ctx, [v, pan], (s) => {
        v.set({
          rateHz: s.rateHz,
          depth: s.depth * CHORUS_SWING,
          pre: s.delay,
          wave: s.wave as Wave,
          spread: s.phase,
        });
        pan.set({ rateHz: s.rateHz, width: 0.9, wave: s.wave as Wave });
      });
    }
    case 'SPA': {
      const pan = new AutoPan(ctx);
      return chain(ctx, [pan], (s) =>
        pan.set({ rateHz: s.rateHz, width: s.depth, wave: s.wave as Wave }),
      );
    }
    case 'HPA': {
      const h = new HaasPan(ctx);
      return chain(ctx, [h], (s) =>
        h.set({ rateHz: s.rateHz, depth: s.depth, wave: s.wave as Wave }),
      );
    }
    case 'DOP': {
      // A source passing by: pitch swept by a wide delay swing, image moving with it.
      const v = new Voices(ctx, 1, 0.05);
      const pan = new AutoPan(ctx);
      return chain(ctx, [v, pan], (s) => {
        v.set({ rateHz: s.rateHz, depth: 0.0005 + s.delay * 0.5, pre: 0, width: 0 });
        pan.set({ rateHz: s.rateHz, width: s.depth });
      });
    }
    case 'VIB': {
      // Vibrato unit then tremolo unit on the same LFO frequency (p.45 note); FEEDBK sets the
      // tremolo depth here, PHASE the tremolo's ch2 phase.
      const v = new Voices(ctx, 1, 0.55);
      const t = new Tremolo(ctx);
      return chain(ctx, [v, t], (s) => {
        v.set({
          rateHz: s.rateHz,
          depth: s.depth * 0.004,
          pre: s.delay,
          wave: s.wave as Wave,
          spread: 0,
          width: 0,
        });
        t.set({
          rateHz: s.rateHz,
          depth: Math.abs(s.feedback),
          wave: s.wave as Wave,
          phase: s.phase,
        });
      });
    }
    case 'RNG': {
      const r = new RingMod(ctx);
      return chain(ctx, [r], (s) =>
        r.set({ osc: s.oscHz, time: s.delay, fb: Math.abs(s.feedback) * 0.95 }),
      );
    }
    case 'RTY': {
      const r = new Rotary(ctx);
      return chain(ctx, [r], (s) =>
        r.set({ fast: s.fast, depth: s.depth, drive: Math.abs(s.feedback) }),
      );
    }
    default: {
      const t = new Through(ctx);
      return chain(ctx, [t], () => {});
    }
  }
}

/** A pre-effect: SEQ tilt EQ, SXE / DEX exciters, GTE gate, CMP compressor (pp.13–17). */
interface Pre extends Block {
  set(amount: number): void;
}

function buildPre(ctx: BaseAudioContext, kind: string): Pre {
  switch (kind) {
    case 'SEQ': {
      const e = new Eq3(ctx, 250, 1000, 4000);
      return {
        input: e.input,
        output: e.output,
        dispose: () => e.dispose(),
        set: (x) => e.set({ low: (0.5 - x) * 24, high: (x - 0.5) * 24 }),
      };
    }
    case 'SXE':
    case 'DEX': {
      const e = new Exciter(ctx);
      const hz = kind === 'SXE' ? 3000 : 1800;
      return {
        input: e.input,
        output: e.output,
        dispose: () => e.dispose(),
        set: (x) => e.set({ amount: x, freq: hz, level: 1 }),
      };
    }
    case 'GTE': {
      const g = new Gate(ctx);
      return {
        input: g.input,
        output: g.output,
        dispose: () => g.dispose(),
        set: (x) => g.set({ threshold: 0.002 + x * 0.25, release: 0.15 }),
      };
    }
    case 'CMP': {
      const d = new Dynamics(ctx);
      return {
        input: d.input,
        output: d.output,
        dispose: () => d.dispose(),
        set: (x) =>
          d.set({ threshold: -40 * x, ratio: 4, attack: 0.005, release: 0.2, makeup: 14 * x }),
      };
    }
    default: {
      const t = new Through(ctx);
      return { input: t.input, output: t.output, dispose: () => t.dispose(), set: () => {} };
    }
  }
}

export class DpsM7Unit extends RackUnit {
  private readonly pre = new Slot<Pre>(this.ctx);
  private readonly mod = new Slot<Algo>(this.ctx);
  private readonly direct = this.ctx.createGain();
  private readonly effect = this.ctx.createGain();
  private readonly env = new Envelope(this.ctx);
  private readonly envAmount = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.send.connect(this.pre.input);
    this.pre.output.connect(this.direct).connect(this.ret);
    this.pre.output.connect(this.mod.input);
    this.mod.output.connect(this.effect).connect(this.ret);
    this.send.connect(this.env.input);
    this.env.output.connect(this.envAmount).connect(this.effect.gain);
    this.env.speed(0.08);
  }

  /** MIX is applied inside (after the pre-effect); the base only handles BYPASS. */
  protected override balance() {
    return { dry: 0, wet: 1 };
  }

  protected apply(p: Params) {
    const s = m7Settings(p);
    this.pre.use(s.pre, () => buildPre(this.ctx, s.pre)).set(s.preAmount);
    this.mod.use(s.algo.code, () => buildAlgo(this.ctx, s.algo)).set(s);
    const { dry, wet } = mixSends(p['mix']);
    glide(this.direct.gain, dry, this.ctx);
    // ENV: + brings the effect in with the input's envelope, − ducks it (a full-scale envelope
    // reads about 0.6, so ×1.6 spans the whole level).
    const e = s.env;
    glide(this.effect.gain, wet * (e > 0 ? 1 - e : 1), this.ctx);
    glide(this.envAmount.gain, wet * e * 1.6, this.ctx);
  }

  override dispose() {
    this.pre.dispose();
    this.mod.dispose();
    this.env.dispose();
    super.dispose();
  }
}
