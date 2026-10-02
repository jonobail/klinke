// DPS-D7 digital delay (manual p.12): INPUT → EQ → DELAY → AUTO PAN → OUTPUT.
//
//   send → EQ (bass / treble) → [algorithm, in a crossfading slot] ─┬─ (pan off) ──────┬→ ret
//                                                                  └→ auto panner ────┘
//
// The seven delay algorithms (pp.15–20) are built from the shared blocks: two-line delays with a
// feedback matrix (STD, FBD, DBD in series, MTD cross-coupled), tap patterns as sparse impulse
// responses (TPD), and a line with feedback read out through taps (LGD, PTD). DRY and EFFECT are
// the front-panel output knobs (p.8).

import { type D7Algo, D7_SHELF_HZ, d7Settings } from '../../core/devices/dps-d7';
import { longTaps, panTaps, reflectionTaps } from '../../core/devices/dps-taps';
import { type Wave } from '../../core/devices/dps-dsp';
import { faderGain } from '../../core/sound';
import { type Params, glide } from '../unit';
import { AutoPan, type Block, Eq3, Slot, StereoDelay, TapDelay, TapLine } from './dps-blocks';
import { RackUnit } from './rack-unit';

type Settings = ReturnType<typeof d7Settings>;

/** A delay algorithm: a block and how to set it. */
interface Algo extends Block {
  set(s: Settings): void;
}

function buildAlgo(ctx: BaseAudioContext, a: D7Algo): Algo {
  const loop = (s: Settings) => ({ bassDb: s.bassDb, trebleDb: s.trebleDb });
  switch (a.code) {
    case 'STD':
    case 'FBD': {
      const d = new StereoDelay(ctx, 1.4);
      return {
        input: d.input,
        output: d.output,
        dispose: () => d.dispose(),
        set: (s) =>
          d.set({
            timeL: s.time,
            timeR: s.time2,
            self: a.feedback ? s.feedback : 0,
            cross: 0,
            ...(a.feedback ? loop(s) : {}),
          }),
      };
    }
    case 'DBD': {
      // Delay 1 (pre delay line, its own feedback) feeds delay 2 (main line, its own feedback).
      const d1 = new StereoDelay(ctx, 0.7);
      const d2 = new StereoDelay(ctx, 0.7);
      d1.output.connect(d2.input);
      return {
        input: d1.input,
        output: d2.output,
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
        set: (s) => {
          d1.set({ timeL: s.time, timeR: s.time, self: s.feedback, cross: 0, ...loop(s) });
          d2.set({ timeL: s.time2, timeR: s.time2, self: s.feedback, cross: 0, ...loop(s) });
        },
      };
    }
    case 'TPD': {
      const t = new TapDelay(ctx);
      return {
        input: t.input,
        output: t.output,
        dispose: () => t.dispose(),
        // FEEDBK has no loop to drive here; it tilts the tap levels (interpretation).
        set: (s) => t.setTaps(reflectionTaps(38, s.time, s.time2, s.feedback)),
      };
    }
    case 'LGD': {
      const t = new TapLine(ctx, 2.8);
      return {
        input: t.input,
        output: t.output,
        dispose: () => t.dispose(),
        set: (s) =>
          t.set({ fbTime: s.time, fb: s.feedback, ...loop(s), taps: longTaps(s.time2, s.time) }),
      };
    }
    case 'PTD': {
      // Pre delay line with its own (lighter) feedback, then the main line with five panned taps.
      const pre = new StereoDelay(ctx, 0.7);
      const main = new TapLine(ctx, 0.7);
      pre.output.connect(main.input);
      return {
        input: pre.input,
        output: main.output,
        dispose: () => {
          pre.dispose();
          main.dispose();
        },
        set: (s) => {
          pre.set({ timeL: s.time2, timeR: s.time2, self: s.feedback * 0.5, cross: 0 });
          main.set({ fbTime: s.time, fb: s.feedback, ...loop(s), taps: panTaps(s.time) });
        },
      };
    }
    default: {
      // MTD: three early reflections per channel off the pre delay line, plus two main lines
      // that feed back mostly into each other (the "cross feedback").
      const input = ctx.createGain();
      const output = ctx.createGain();
      const er = new TapDelay(ctx);
      const d = new StereoDelay(ctx, 0.7);
      input.connect(er.input);
      input.connect(d.input);
      er.output.connect(output);
      d.output.connect(output);
      const reflections = [0.011, 0.017, 0.023, 0.013, 0.019, 0.029].map((t, i) => ({
        time: t,
        level: 0.35 - 0.05 * (i % 3),
        pan: i < 3 ? -0.8 : 0.8,
      }));
      return {
        input,
        output,
        dispose: () => {
          er.dispose();
          d.dispose();
          input.disconnect();
          output.disconnect();
        },
        set: (s) => {
          er.setTaps(reflections);
          d.set({
            timeL: s.time,
            timeR: s.time2,
            self: s.feedback * 0.35,
            cross: s.feedback * 0.65,
            ...loop(s),
          });
        },
      };
    }
  }
}

export class DpsD7Unit extends RackUnit {
  private readonly eq = new Eq3(this.ctx, D7_SHELF_HZ.bass, 1000, D7_SHELF_HZ.treble);
  private readonly slot = new Slot<Algo>(this.ctx);
  private readonly pan = new AutoPan(this.ctx);
  private readonly direct = this.ctx.createGain();
  private readonly panned = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.send.connect(this.eq.input);
    this.eq.output.connect(this.slot.input);
    this.slot.output.connect(this.direct).connect(this.ret);
    this.slot.output.connect(this.pan.input);
    this.pan.output.connect(this.panned).connect(this.ret);
  }

  /** DRY and EFFECT knobs (p.8) instead of a single mix. */
  protected override balance(p: Params) {
    return { dry: faderGain(p['dry']), wet: faderGain(p['effect']) };
  }

  protected apply(p: Params) {
    const s = d7Settings(p);
    const algo = this.slot.use(s.algo.code, () => buildAlgo(this.ctx, s.algo));
    algo.set(s);
    // Algorithms with a loop EQ use the knobs there; the others use the EQ block.
    const eqBlock = !s.algo.feedback;
    this.eq.set({ low: eqBlock ? s.bassDb : 0, high: eqBlock ? s.trebleDb : 0 });
    const on = s.panWave >= 0;
    if (on) this.pan.set({ rateHz: s.panHz, width: s.panWidth, wave: s.panWave as Wave });
    glide(this.direct.gain, on ? 0 : 1, this.ctx, 0.03);
    glide(this.panned.gain, on ? 1 : 0, this.ctx, 0.03);
  }

  override dispose() {
    this.slot.dispose();
    this.pan.dispose();
    super.dispose();
  }
}
