// Builds the DPS multi-effect types (core/devices/dps-fx.ts) out of the shared blocks, and the
// effect block the DPS-V55 / DPS-V77 use: an engine in a crossfading slot with its own direct /
// effect balance (the guide's "Direct Level" / "Effect Level", or "BAL" on the Mono-Pairs).

import { centsRatio, clamp, type Wave } from '../../core/devices/dps-dsp';
import { type Engine, type FxDef, fxValues } from '../../core/devices/dps-fx';
import { erTaps, reflectionTaps } from '../../core/devices/dps-taps';
import { mixSends } from '../../core/sound';
import { glide } from '../unit';
import {
  AutoPan,
  type Block,
  Drive,
  Dynamics,
  Eq3,
  Exciter,
  Gate,
  HaasPan,
  Phaser,
  PitchShift,
  Reverb,
  RingMod,
  Rotary,
  Slot,
  StereoDelay,
  TapDelay,
  Tremolo,
  Voices,
  Wah,
} from './dps-blocks';

type Values = Record<string, number>;

/** An effect type, built: a block whose `set` takes `fxValues` output. */
export interface FxEngine extends Block {
  set(v: Values): void;
}

const v0 = (v: Values, key: string, d = 0) => v[key] ?? d;
const rateOf = (v: Values) => v0(v, 'rateHz', 0.5);

/** One output stage after any block, so engines can be level-matched by ear. */
function engine<B extends Block>(block: B, set: (v: Values) => void, gain = 1): FxEngine {
  const out = block.output.context.createGain();
  out.gain.value = gain;
  block.output.connect(out);
  return {
    input: block.input,
    output: out,
    set,
    dispose: () => {
      block.dispose();
      out.disconnect();
    },
  };
}

const COLOR_HZ = [1500, 2400, 3500, 5000, 7000, 10000];
/** Amp-F / B / M / J: drive and voicing (interpretation: the guide only names them). */
const AMPS = [
  { gain: 0.25, low: 90, tone: 5000 },
  { gain: 0.45, low: 60, tone: 3500 },
  { gain: 0.75, low: 110, tone: 4500 },
  { gain: 0.1, low: 80, tone: 6500 },
];
/** Mic placement as a cabinet low-pass: Front, Slant, Upper, On (on-axis is brightest). */
const MIC_HZ = [4500, 3200, 2400, 6500];

export function makeEngine(ctx: BaseAudioContext, kind: Engine, def?: FxDef): FxEngine {
  switch (kind) {
    case 'reverb': {
      const r = new Reverb(ctx);
      return engine(
        r,
        (v) =>
          r.setShape({
            rt: v0(v, 'rt', 2),
            pre: v0(v, 'pre'),
            damp: v0(v, 'damp', 0.4),
            size: v0(v, 'size', 1),
            early: v0(v, 'early', 0.3),
            seed: def?.no ?? 7,
          }),
        1.2,
      );
    }
    case 'er': {
      const t = new TapDelay(ctx);
      return engine(t, (v) => t.setTaps(erTaps(v0(v, 'erType'), v0(v, 'erMode', 1), v0(v, 'pre'))));
    }
    case 'taps': {
      const t = new TapDelay(ctx);
      return engine(t, (v) =>
        t.setTaps(
          reflectionTaps(
            Math.round(v0(v, 'taps', 12)),
            v0(v, 'time', 0.5),
            0.005,
            v0(v, 'decay', 0.5) * 2 - 1,
          ),
        ),
      );
    }
    case 'dim': {
      // 3 Dimension: each channel placed on a circle; behind the listener (past ±90°) is darker.
      const input = ctx.createGain();
      const output = ctx.createGain();
      const parts = ['pan1', 'pan2', 'pan3'].map((key) => {
        const pan = ctx.createStereoPanner();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        const g = ctx.createGain();
        input.connect(lp).connect(pan).connect(g).connect(output);
        return { key, pan, lp, g };
      });
      const used = def?.knobs.length ?? 2;
      return {
        input,
        output,
        set: (v) =>
          parts.forEach((p, i) => {
            const deg = v0(v, p.key);
            const rad = (deg * Math.PI) / 180;
            glide(p.pan.pan, Math.sin(rad), ctx);
            glide(
              p.lp.frequency,
              Math.abs(deg) > 90 ? 18000 - ((Math.abs(deg) - 90) / 90) * 14000 : 18000,
              ctx,
            );
            glide(p.g.gain, i < used ? 1 / Math.sqrt(used) : 0, ctx);
          }),
        dispose: () => {
          input.disconnect();
          output.disconnect();
        },
      };
    }
    case 'chorus': {
      const n = Math.round(def?.fixed?.['voices'] ?? 2);
      const c = new Voices(ctx, n, 1.3, !!def?.fixed?.['ensemble']);
      return engine(c, (v) =>
        c.set({
          rateHz: rateOf(v),
          depth: v0(v, 'depth', 0.4) * 0.01,
          pre: v0(v, 'pre', 0.01),
          rateR: v['rateR'],
          wave: v0(v, 'wave') as Wave,
          spread: 90,
        }),
      );
    }
    case 'flanger': {
      const f = new Voices(ctx, 1);
      return engine(f, (v) =>
        f.set({
          rateHz: rateOf(v),
          depth: 0.0005 + 0.0045 * v0(v, 'depth', 0.5),
          pre: 0.0005,
          fb: v0(v, 'fb'),
          spread: 90,
        }),
      );
    }
    case 'vibrato': {
      const f = new Voices(ctx, 1);
      return engine(
        f,
        (v) =>
          f.set({
            rateHz: rateOf(v),
            depth: 0.003 * v0(v, 'depth', 0.5),
            pre: 0,
            spread: (v0(v, 'chPhase') / 20) * 180,
            width: 0.6,
          }),
        1.3,
      );
    }
    case 'moddelay': {
      const f = new Voices(ctx, 1);
      return engine(f, (v) =>
        f.set({
          rateHz: rateOf(v),
          depth: 0.003 * v0(v, 'depth', 0.3),
          pre: v0(v, 'time', 0.3),
          fb: v0(v, 'fb'),
          spread: 90,
          lpf: 7000,
        }),
      );
    }
    case 'rotary': {
      const r = new Rotary(ctx);
      return engine(r, (v) =>
        r.set({ fast: v0(v, 'fast') >= 1, depth: v0(v, 'depth', 0.7), drive: v0(v, 'drive') }),
      );
    }
    case 'delay': {
      const d = new StereoDelay(ctx, 1.4);
      return engine(d, (v) => {
        const fb = v0(v, 'fb');
        const cross = v0(v, 'cross') >= 1;
        const t = v0(v, 'time', 0.3);
        d.set({
          timeL: t,
          timeR: v['timeR'] ?? t,
          self: cross ? 0 : fb,
          cross: cross ? fb : 0,
          // Ping-pong: the input enters on the left and bounces across (V55 p.20, Mode Cross).
          inR: cross ? 0 : 1,
          lpf: v0(v, 'lpf', 8000),
        });
      });
    }
    case 'pitch': {
      const input = ctx.createGain();
      const voices = [new PitchShift(ctx), new PitchShift(ctx)];
      const m = ctx.createChannelMerger(2);
      voices.forEach((p, c) => {
        input.connect(p.input);
        p.output.connect(m, 0, c);
      });
      const out = ctx.createGain();
      m.connect(out);
      return {
        input,
        output: out,
        set: (v) => {
          const reverse = v0(v, 'reverse') >= 1;
          const ratio = centsRatio(v0(v, 'pitch'));
          voices.forEach((p, c) =>
            p.set({
              ratio: reverse ? -ratio : ratio,
              window: reverse ? Math.max(0.02, v0(v, 'window', 0.2)) : 0.06,
              // A few ms between the channels widens a stereo shifter.
              pre: v0(v, 'pre') + c * 0.011,
              fb: v0(v, 'fb'),
            }),
          );
        },
        dispose: () => {
          voices.forEach((p) => p.dispose());
          input.disconnect();
          out.disconnect();
        },
      };
    }
    case 'phaser': {
      const p = new Phaser(ctx, 8);
      return engine(p, (v) =>
        p.set({
          rateHz: rateOf(v),
          depth: v0(v, 'depth', 0.5),
          manual: v0(v, 'manual', 0.5),
          resonance: v0(v, 'resonance', 0.5),
        }),
      );
    }
    case 'panner': {
      const a = new AutoPan(ctx);
      return engine(a, (v) =>
        a.set({ rateHz: rateOf(v), width: v0(v, 'depth', 0.7), wave: v0(v, 'wave') as Wave }),
      );
    }
    case 'haas': {
      const h = new HaasPan(ctx);
      return engine(h, (v) =>
        h.set({ rateHz: rateOf(v), depth: v0(v, 'depth', 0.7), wave: v0(v, 'wave') as Wave }),
      );
    }
    case 'tremolo': {
      const t = new Tremolo(ctx);
      return engine(t, (v) =>
        t.set({
          rateHz: rateOf(v),
          depth: v0(v, 'depth', 0.5),
          phase: (v0(v, 'chPhase') / 20) * 180,
        }),
      );
    }
    case 'drive': {
      const d = new Drive(ctx);
      return engine(d, (v) =>
        d.set({
          gain: v0(v, 'gain', 0.5),
          level: 1.4 * v0(v, 'level', 0.5),
          toneHz: COLOR_HZ[Math.round(v0(v, 'color', 2))],
        }),
      );
    }
    case 'amp': {
      const d = new Drive(ctx);
      return engine(d, (v) => {
        const a = AMPS[Math.round(v0(v, 'amp'))];
        d.set({
          gain: a.gain,
          level: 1.4 * v0(v, 'level', 0.7),
          toneHz: Math.min(a.tone, MIC_HZ[Math.round(v0(v, 'mic'))]),
          lowHz: a.low,
        });
      });
    }
    case 'eq': {
      const e = new Eq3(ctx);
      return engine(e, (v) => e.set({ low: v0(v, 'low'), mid: v0(v, 'mid'), high: v0(v, 'high') }));
    }
    case 'dynamics': {
      const d = new Dynamics(ctx);
      return engine(d, (v) => {
        if (v0(v, 'limit') >= 1) {
          d.set({
            threshold: -30 * (1 - v0(v, 'threshold', 0.7)),
            ratio: v0(v, 'ratio', 20),
            attack: 0.001,
            release: 0.02 + 0.5 * v0(v, 'release', 0.3),
            knee: 0,
            makeup: 0,
          });
        } else {
          const sens = v0(v, 'sens', 0.5);
          d.set({
            threshold: -40 * sens,
            ratio: 4,
            attack: 0.001 + 0.1 * v0(v, 'attack', 0.2),
            release: 0.02 + 0.8 * v0(v, 'release', 0.3),
            makeup: 14 * sens,
          });
        }
      });
    }
    case 'exciter': {
      const x = new Exciter(ctx);
      return engine(x, (v) =>
        x.set({
          amount: v0(v, 'gain', 0.5),
          freq: 1000 * Math.pow(10, (v0(v, 'freq', 16) - 1) / 31),
          level: 1.4 * v0(v, 'level', 0.7),
        }),
      );
    }
    case 'gate': {
      const g = new Gate(ctx);
      return engine(g, (v) =>
        g.set({
          threshold: 0.002 + 0.15 * v0(v, 'threshold', 0.2),
          release: 0.02 + v0(v, 'release', 0.3),
          hold: v0(v, 'hold', 0.1),
        }),
      );
    }
    case 'wah': {
      const w = new Wah(ctx);
      return engine(w, (v) =>
        w.set({
          sens: v0(v, 'sens', 50) / 100,
          speed: 0.01 + (v0(v, 'release', 10) / 50) * 0.3,
          baseHz: 350,
          q: 5,
        }),
      );
    }
    case 'ringmod': {
      const r = new RingMod(ctx);
      return engine(r, (v) =>
        r.set({ osc: v0(v, 'osc', 440), time: v0(v, 'time'), fb: v0(v, 'fb') }),
      );
    }
    case 'pair': {
      // Mono-Pair: two mono effects, one per channel (V55 manual p.8).
      const [kl, kr] = def!.pair!;
      const input = ctx.createGain();
      const l = makeEngine(ctx, kl, def);
      const r = makeEngine(ctx, kr, def);
      const m = ctx.createChannelMerger(2);
      [l, r].forEach((e, c) => {
        const mono = ctx.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = 'explicit';
        input.connect(e.input);
        e.output.connect(mono).connect(m, 0, c);
      });
      const out = ctx.createGain();
      // Two half-width mono effects: keep the pair as loud as one stereo effect.
      out.gain.value = Math.SQRT2;
      m.connect(out);
      return {
        input,
        output: out,
        set: (v) => {
          l.set(v);
          r.set({
            ...v,
            pitch: v['pitchR'] ?? v['pitch'] ?? 0,
            rateHz: rateOf(v) * (v['rateR'] ?? 1),
          });
        },
        dispose: () => {
          l.dispose();
          r.dispose();
          input.disconnect();
          out.disconnect();
        },
      };
    }
  }
}

/**
 * One effect block: the engine in a crossfading `Slot`, with its direct / effect balance. Insert
 * types (EQ, dynamics, drive…) have no direct level in the guide, so they're all effect.
 */
export class FxBlock implements Block {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly slot: Slot<FxEngine>;
  private readonly dry: GainNode;
  private readonly wet: GainNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.slot = new Slot<FxEngine>(ctx);
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.slot.input);
    this.slot.output.connect(this.wet).connect(this.output);
  }

  /** `def` undefined = OFF (straight through). */
  set(def: FxDef | undefined, knobs: number[], balance: number) {
    if (!def) {
      glide(this.dry.gain, 1, this.ctx, 0.02);
      glide(this.wet.gain, 0, this.ctx, 0.02);
      return;
    }
    const e = this.slot.use(`${def.code}`, () => makeEngine(this.ctx, def.engine, def));
    e.set(fxValues(def, knobs));
    const { dry, wet } = def.insert ? { dry: 0, wet: 1 } : mixSends(clamp(balance, 0, 1));
    glide(this.dry.gain, dry, this.ctx, 0.02);
    glide(this.wet.gain, wet, this.ctx, 0.02);
  }

  dispose() {
    this.slot.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}
