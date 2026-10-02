// DPS-V77: two blocks, each EQ (pre or post) + FX, joined by the structure, then the MIX block
// (manual pp.8–9, 19):
//
//   SERI 1  send → A → B          PARA  send ─┬→ A ─┐       DUAL  ch1 → A → L
//   SERI 2  send → B → A                      └→ B ─┴→ mix        ch2 → B → R
//
//   mix = FX A level × A + FX B level × B + Dry level × send  → ret
//
// In the serial structures both block outputs reach the mixer, so FX A / FX B balance the first
// effect against the second (interpretation). Changing structure re-patches the blocks behind a
// short mute: the two serial orders would otherwise make a loop with no delay in it.

import { SEQ, type EQ_MODES, v77Settings } from '../../core/devices/dps-v77';
import { type Params, glide } from '../unit';
import { Eq3 } from './dps-blocks';
import { FxBlock } from './dps-engines';
import { RackUnit } from './rack-unit';

class V77Block {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly fx: FxBlock;
  private readonly pre: Eq3;
  private readonly post: Eq3;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = new Eq3(ctx, SEQ.lowHz, 1000, SEQ.highHz);
    this.post = new Eq3(ctx, SEQ.lowHz, 1000, SEQ.highHz);
    this.fx = new FxBlock(ctx);
    this.input.connect(this.pre.input);
    this.pre.output.connect(this.fx.input);
    this.fx.output.connect(this.post.input);
    this.post.output.connect(this.output);
  }

  /** A flat shelf is transparent, so OFF / PRE / POST is just which EQ gets the gains. */
  eq(mode: (typeof EQ_MODES)[number], low: number, high: number) {
    this.pre.set({ low: mode === 'PRE' ? low : 0, high: mode === 'PRE' ? high : 0 });
    this.post.set({ low: mode === 'POST' ? low : 0, high: mode === 'POST' ? high : 0 });
  }

  dispose() {
    this.fx.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

export class DpsV77Unit extends RackUnit {
  private readonly a = new V77Block(this.ctx);
  private readonly b = new V77Block(this.ctx);
  private readonly feed = this.ctx.createGain();
  private readonly split = this.ctx.createChannelSplitter(2);
  private readonly merge = this.ctx.createChannelMerger(2);
  private readonly monoA = this.mono();
  private readonly monoB = this.mono();
  private readonly lvlA = this.ctx.createGain();
  private readonly lvlB = this.ctx.createGain();
  private readonly dryLvl = this.ctx.createGain();
  private readonly mute = this.ctx.createGain();
  private structure = -1;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(ctx: AudioContext) {
    super(ctx);
    // Up-mixed to stereo first, so a mono source reaches both DUAL channels.
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = 'explicit';
    stereo.channelInterpretation = 'speakers';
    this.send.connect(stereo).connect(this.split);
    this.send.connect(this.feed);
    this.send.connect(this.dryLvl).connect(this.ret);
    this.lvlA.connect(this.mute);
    this.lvlB.connect(this.mute);
    this.merge.connect(this.mute);
    this.mute.connect(this.ret);
    this.monoA.connect(this.merge, 0, 0);
    this.monoB.connect(this.merge, 0, 1);
  }

  /** The base's own dry path is off: the MIX block's Dry level does that job. */
  protected override balance() {
    return { dry: 0, wet: 1 };
  }

  protected apply(p: Params) {
    const s = v77Settings(p);
    this.a.fx.set(s.a.fx, s.a.knobs, 1);
    this.b.fx.set(s.b.fx, s.b.knobs, 1);
    this.a.eq(s.a.eq, s.a.lowDb, s.a.highDb);
    this.b.eq(s.b.eq, s.b.lowDb, s.b.highDb);
    glide(this.lvlA.gain, s.fxA, this.ctx);
    glide(this.lvlB.gain, s.fxB, this.ctx);
    glide(this.dryLvl.gain, s.dry, this.ctx);
    // DUAL sends each block to its own side; keep the levels there too.
    glide(this.monoA.gain, s.fxA, this.ctx);
    glide(this.monoB.gain, s.fxB, this.ctx);
    if (s.structure !== this.structure) this.restructure(s.structure);
  }

  private restructure(structure: number) {
    const first = this.structure < 0;
    this.structure = structure;
    clearTimeout(this.timer);
    if (first) return this.patch(structure);
    const t = this.ctx.currentTime;
    this.mute.gain.setTargetAtTime(0, t, 0.008);
    this.timer = setTimeout(() => {
      this.patch(this.structure);
      this.mute.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
    }, 40);
  }

  private patch(structure: number) {
    const { a, b } = this;
    this.split.disconnect();
    this.feed.disconnect();
    a.output.disconnect();
    b.output.disconnect();
    if (structure === 3) {
      this.split.connect(a.input, 0);
      this.split.connect(b.input, 1);
      a.output.connect(this.monoA);
      b.output.connect(this.monoB);
      return;
    }
    const [first, second] = structure === 1 ? [b, a] : [a, b];
    this.feed.connect(first.input);
    if (structure === 2) this.feed.connect(second.input);
    else first.output.connect(second.input);
    a.output.connect(this.lvlA);
    b.output.connect(this.lvlB);
  }

  private mono() {
    const g = this.ctx.createGain();
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    return g;
  }

  override dispose() {
    clearTimeout(this.timer);
    this.a.dispose();
    this.b.dispose();
    super.dispose();
  }
}
