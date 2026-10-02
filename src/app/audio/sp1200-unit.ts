// SP-1200, after the owner's manual:
//
//   SAMPLE IN → preamp (+00/+20/+40 dB) → GAIN → input filter → 26.04 kHz / 12-bit capture → memory
//   pad → sound (A1–D8) → pitch by skipping / repeating samples → level / decay → output channel
//         channel 1–2: dynamic filter · 3–6: fixed filter · 7–8: unfiltered → MIX VOLUME → MIX OUT
//
// Each output channel plays one sound at a time: a new hit on a busy channel cuts the old one off
// ("channel ripoff", §1N). Sounds live in memory only, as on the hardware until saved to disk.
// Capture uses a ScriptProcessorNode so the unit stays synchronous to build (no AudioWorklet).

import { faderGain } from '../core/sound';
import {
  BANKS,
  KIT_NAMES,
  PADS,
  PREAMPS,
  RATE,
  ZONES,
  channelFilter,
  decaySeconds,
  fitZone,
  formatStatus,
  kitSound,
  largestFree,
  padForStep,
  pitchRatio,
  preampGain,
  region,
  renderPitched,
  sampleLength,
  thresholdIndex,
  thresholdLevel,
  toSpMemory,
} from '../core/sp1200';
import { stepIndex } from '../core/synth';
import { type Params, type Playable, Unit, glide } from './unit';

interface Sound {
  data: Float32Array;
  zone: number;
  name: string;
  /** Bumped whenever the data changes, to invalidate rendered buffers. */
  version: number;
}

interface Channel {
  input: GainNode;
  filters: BiquadFilterNode[];
  voice?: { src: AudioBufferSourceNode; gain: GainNode };
}

/** Rendered (pitched, truncated) buffers kept for reuse. */
const CACHE_SIZE = 48;
/** How long "Sample is good" and friends stay on the display. */
const MESSAGE_MS = 2500;

export class Sp1200Unit extends Unit implements Playable {
  private p: Params = {};
  private readonly sounds = new Map<string, Sound>();
  private readonly zones: number[] = Array(ZONES).fill(0);
  private readonly cache = new Map<string, AudioBuffer>();
  private version = 0;

  // Sampling input
  private readonly in = this.ctx.createGain();
  private readonly preamp = this.ctx.createGain();
  private readonly trim = this.ctx.createGain();
  private readonly inputFilter = this.ctx.createBiquadFilter();
  private readonly capture = this.ctx.createScriptProcessor(2048, 1, 1);
  private readonly sink = this.ctx.createGain();
  private phase: 'idle' | 'armed' | 'sampling' = 'idle';
  private chunks: Float32Array[] = [];
  private captured = 0;
  private wanted = 0;
  private target = '';
  private message = '';
  private messageUntil = 0;

  // Outputs
  private readonly channels: Channel[] = [];
  private readonly bus = this.ctx.createGain();
  private readonly volume = this.ctx.createGain();

  constructor(ctx: AudioContext) {
    super(ctx);
    this.inputs['in'] = this.in;

    // Input: the converter samples at 26.04 kHz, so keep the input below its 13 kHz Nyquist.
    this.inputFilter.type = 'lowpass';
    this.inputFilter.frequency.value = 12000;
    this.inputFilter.Q.value = -3.01; // Web Audio Q is in dB: Butterworth
    this.sink.gain.value = 0;
    this.in.connect(this.preamp).connect(this.trim).connect(this.inputFilter);
    this.inputFilter.connect(this.capture).connect(this.sink).connect(ctx.destination);
    this.analyser(this.inputFilter); // the VU meter
    this.capture.onaudioprocess = (e) => this.onInput(e.inputBuffer.getChannelData(0));

    // Eight output channels, filtered by type (§1M), summed to MIX OUT.
    for (let ch = 1; ch <= 8; ch++) {
      const input = ctx.createGain();
      const kind = channelFilter(ch);
      const filters = (kind === 'dynamic' ? [12000] : kind === 'fixed' ? [9000, 9000] : []).map(
        (hz) => {
          const f = ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = hz;
          f.Q.value = kind === 'dynamic' ? 3 : -3.01;
          return f;
        },
      );
      let node: AudioNode = input;
      for (const f of filters) node = node.connect(f);
      node.connect(this.bus);
      this.channels.push({ input, filters });
    }
    this.bus.connect(this.volume);
    this.output = this.volume;

    // Bank A: the stand-in kit (see core/sp1200.ts).
    for (let i = 0; i < PADS; i++) this.store(`A${i + 1}`, kitSound(i), KIT_NAMES[i]);
  }

  set(p: Params) {
    this.p = p;
    glide(this.preamp.gain, preampGain(stepIndex(p['preamp'], PREAMPS.length)), this.ctx);
    glide(this.trim.gain, faderGain(p['gain']), this.ctx);
    glide(this.volume.gain, faderGain(p['volume']) * 0.8, this.ctx);
  }

  // ── Playing ───────────────────────────────────────────

  private current(): string {
    return `${BANKS[stepIndex(this.p['bank'], 4)]}${stepIndex(this.p['pad'], PADS) + 1}`;
  }

  noteOn(_note: number, step: number) {
    const pad = padForStep(step);
    if (pad >= 0) this.trigger(`${BANKS[stepIndex(this.p['bank'], 4)]}${pad + 1}`);
  }

  /** Pads are one-shots: lifting the key doesn't stop the sound. */
  noteOff() {}

  pitchBend() {}

  allNotesOff() {
    for (const ch of this.channels) this.cut(ch);
  }

  private trigger(id: string) {
    const sound = this.sounds.get(id);
    if (!sound) return;
    const p = this.p;
    const ch = this.channels[stepIndex(p[`ch${id}`], 8)];
    const decayMode = p[`dmode${id}`] >= 0.5;
    const slider = p[`tune${id}`];
    const ratio = decayMode ? 1 : pitchRatio(slider);
    const r = region(sound.data.length, p[`start${id}`], p[`end${id}`], p[`loop${id}`]);
    const natural = r.loop ? 1 : (r.end - r.start) / RATE / ratio;
    const decay = decayMode ? decaySeconds(slider, natural) : r.loop ? 4 : Infinity;
    const buffer = this.render(id, sound, ratio, r, Math.min(4, decay + 0.05));

    const t = this.ctx.currentTime;
    this.cut(ch); // one sound per channel
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    const level = faderGain(p[`lvl${id}`]);
    gain.gain.setValueAtTime(level, t);
    // A decay shorter than the sound fades it 60 dB over that time.
    if (Number.isFinite(decay)) gain.gain.setTargetAtTime(0, t, decay / 6.9);
    src.connect(gain).connect(ch.input);
    src.start(t);
    src.onended = () => gain.disconnect();
    ch.voice = { src, gain };

    // Channels 1–2: the filter opens on each hit and closes as the sound decays (SSM2044-style).
    if (channelFilter(this.channels.indexOf(ch) + 1) === 'dynamic') {
      const f = ch.filters[0].frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(13000, t);
      f.setTargetAtTime(2200, t, Math.max(0.04, Math.min(natural, decay) * 0.3));
    }
  }

  private cut(ch: Channel) {
    if (!ch.voice) return;
    const { src, gain } = ch.voice;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0, t, 0.002);
    src.stop(t + 0.02);
    ch.voice = undefined;
  }

  private render(id: string, s: Sound, ratio: number, r: ReturnType<typeof region>, max: number) {
    const key = `${id}|${s.version}|${ratio.toFixed(5)}|${r.start}|${r.end}|${r.loop}|${max.toFixed(2)}`;
    let buf = this.cache.get(key);
    if (buf) {
      this.cache.delete(key); // move to the newest end
    } else {
      const rate = this.ctx.sampleRate;
      const data = renderPitched(s.data, ratio, rate, r, max);
      buf = this.ctx.createBuffer(1, Math.max(1, data.length), rate);
      buf.copyToChannel(data, 0);
      if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, buf);
    return buf;
  }

  // ── Sampling (SAMPLE module) ──────────────────────────

  override command(name: string) {
    if (name === 'arm' || name === 'force') this.startSampling(name === 'arm');
    else if (name === 'stop') this.finishSampling();
    else if (name === 'erase') this.erase(this.current());
    else if (name === 'truncate') this.truncate(this.current());
  }

  private startSampling(armed: boolean) {
    this.target = this.current();
    this.erase(this.target); // recording over a sound erases it (§4G)
    let seconds = sampleLength(this.p['length']);
    if (fitZone(this.zones, Math.round(seconds * RATE)) < 0) seconds = largestFree(this.zones);
    if (seconds < 0.05) return this.say('Memory Full');
    this.wanted = Math.ceil(seconds * this.ctx.sampleRate);
    this.chunks = [];
    this.captured = 0;
    this.phase = armed ? 'armed' : 'sampling';
  }

  private onInput(x: Float32Array) {
    if (this.phase === 'idle') return;
    let from = 0;
    if (this.phase === 'armed') {
      from = thresholdIndex(x, thresholdLevel(this.p['threshold']));
      if (from < 0) return;
      this.phase = 'sampling';
    }
    const take = x.slice(from, from + this.wanted - this.captured);
    this.chunks.push(take);
    this.captured += take.length;
    if (this.captured >= this.wanted) this.finishSampling();
  }

  private finishSampling() {
    if (this.phase !== 'sampling' || !this.captured) {
      this.phase = 'idle';
      return;
    }
    this.phase = 'idle';
    const all = new Float32Array(this.captured);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    const { data, overload } = toSpMemory(all, this.ctx.sampleRate);
    if (!this.store(this.target, data, `SAMPLE ${this.target}`)) return this.say('Memory Full');
    this.say(overload ? 'Sample Overload' : 'Sample is good');
  }

  private store(id: string, data: Float32Array, name: string): boolean {
    const zone = fitZone(this.zones, data.length);
    if (zone < 0) return false;
    this.zones[zone] += data.length;
    this.sounds.set(id, { data, zone, name, version: ++this.version });
    return true;
  }

  private erase(id: string) {
    const s = this.sounds.get(id);
    if (!s) return;
    this.zones[s.zone] -= s.data.length;
    this.sounds.delete(id);
  }

  /** "Make Truncation Permanent": keep only start…end and free the rest (§4H step 10). */
  private truncate(id: string) {
    const s = this.sounds.get(id);
    if (!s) return;
    const p = this.p;
    const r = region(s.data.length, p[`start${id}`], p[`end${id}`], p[`loop${id}`]);
    const data = s.data.slice(r.start, r.end);
    this.zones[s.zone] -= s.data.length - data.length;
    this.sounds.set(id, { ...s, data, version: ++this.version });
  }

  private say(text: string) {
    this.message = text;
    this.messageUntil = performance.now() + MESSAGE_MS;
  }

  /**
   * Display: the sound location, preamp and free time, or the sampling state; then the VU meter;
   * then a machine line for the panel (phase, the selected sound's length, free memory).
   */
  override status(): string {
    const id = this.current();
    const level = this.meters()[0] ?? 0;
    const bars = Math.round(level * 16);
    const vu = '|'.repeat(bars) + '.'.repeat(16 - bars);
    let top: string;
    if (this.phase === 'armed') top = 'Sample Armed';
    else if (this.phase === 'sampling') top = 'Sampling...';
    else if (performance.now() < this.messageUntil) top = this.message;
    else {
      const s = this.sounds.get(id);
      const pre = PREAMPS[stepIndex(this.p['preamp'], PREAMPS.length)];
      top = `${id}${s ? '*' : ' '} ${pre} ${largestFree(this.zones).toFixed(1)}s`;
    }
    const length = this.sounds.get(id)?.data.length ?? 0;
    return formatStatus({ top, vu, phase: this.phase, length, free: largestFree(this.zones) });
  }

  override dispose() {
    this.capture.onaudioprocess = null;
    this.allNotesOff();
    this.capture.disconnect();
    this.sink.disconnect();
    super.dispose();
  }
}
