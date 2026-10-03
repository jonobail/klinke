// KLINKE capture processor: copies its input to the main thread in ~2048-frame blocks, with the
// audio frame number of each block so takes can be lined up with the song. Runs on the audio
// thread (an AudioWorklet), so recording doesn't glitch when the page is busy.
const SILENCE = new Float32Array(128);

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.frames = 0;
    this.start = -1;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.on = false;
        this.port.postMessage({ done: true });
      }
    };
  }

  flush() {
    if (!this.blocks.length) return;
    const channels = this.blocks[0].length;
    const out = Array.from({ length: channels }, (_, c) => {
      const buf = new Float32Array(this.frames);
      let at = 0;
      for (const b of this.blocks) {
        buf.set(b[c], at);
        at += b[c].length;
      }
      return buf;
    });
    this.port.postMessage({ frame: this.start, channels: out }, out.map((b) => b.buffer));
    this.blocks = [];
    this.frames = 0;
    this.start = -1;
  }

  process(inputs) {
    if (!this.on) return false;
    // With nothing sounding upstream the browser hands over no channels at all: record silence,
    // so the take stays continuous and lined up.
    const input = inputs[0] && inputs[0].length ? inputs[0] : [SILENCE, SILENCE];
    if (this.start < 0) this.start = currentFrame;
    this.blocks.push(input.map((c) => c.slice(0)));
    this.frames += input[0].length;
    if (this.frames >= 2048) this.flush();
    return true;
  }
}

registerProcessor('klinke-capture', Capture);
