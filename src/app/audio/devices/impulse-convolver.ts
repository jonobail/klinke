// A ConvolverNode whose impulse is rebuilt only when the settings that shape it change. The first
// impulse is built at once; later ones wait for the knob to settle (like the REVERB pedal), so
// sweeping a knob doesn't render an impulse per step.

export class ImpulseConvolver {
  readonly node: ConvolverNode;
  private key = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly ctx: AudioContext) {
    this.node = ctx.createConvolver();
  }

  /** Renders `build()` into the convolver if `key` differs from the last one. */
  update(key: string, build: (rate: number) => Float32Array[]) {
    if (key === this.key) return;
    const first = this.key === '';
    this.key = key;
    clearTimeout(this.timer);
    const run = () => {
      const rate = this.ctx.sampleRate;
      const channels = build(rate);
      const buffer = this.ctx.createBuffer(channels.length, channels[0].length, rate);
      channels.forEach((data, i) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, i));
      this.node.buffer = buffer;
    };
    if (first) run();
    else this.timer = setTimeout(run, 150);
  }

  dispose() {
    clearTimeout(this.timer);
    this.node.disconnect();
  }
}
