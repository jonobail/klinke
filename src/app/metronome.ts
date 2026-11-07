import { Injectable, effect, inject, untracked } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { accented, clickPitch } from './core/metronome';
import { beatsDue } from './core/schedule';
import { LookAhead } from './look-ahead';
import { RecSettings } from './rec-settings';
import { Transport } from './transport';

/** How often the click scheduler wakes (ms), and how far ahead it books clicks (s). */
const TICK_MS = 25;
const AHEAD_S = 0.12;

/**
 * The metronome: a click on every beat (higher on the downbeat) booked on the audio clock while
 * the song plays with CLICK on, and the count-in before REC. It goes straight to the speakers,
 * not through MAIN • REC, so it's never recorded or exported.
 */
@Injectable({ providedIn: 'root' })
export class Metronome {
  private readonly transport = inject(Transport);
  private readonly engine = inject(AudioEngine);
  private readonly settings = inject(RecSettings);
  private readonly window = new LookAhead(this.transport);
  private timer?: ReturnType<typeof setInterval>;
  private out?: GainNode;
  private booked: AudioScheduledSourceNode[] = [];

  constructor() {
    effect(() => {
      // Seeks and the loop coming round are followed by the look-ahead window itself.
      const on = this.settings.options().click && this.transport.playing();
      untracked(() => (on ? this.begin() : this.end()));
    });
    effect(() => {
      const count = this.transport.countingIn();
      untracked(() => (count ? this.countIn(count.start, count.beats) : this.dropBooked()));
    });
  }

  private begin() {
    clearInterval(this.timer);
    this.window.reset();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private end() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.transport.countingIn()) this.dropBooked();
  }

  private tick() {
    const ctx = this.engine.context;
    const bpm = this.transport.bpm();
    const w = this.window.next((AHEAD_S * bpm) / 60);
    if (!w || !ctx || !this.engine.running()) return;
    const spb = 60 / bpm;
    const now = ctx.currentTime;
    const t = this.transport;
    for (const { beat, offset } of beatsDue(w.from, w.to, t.loopStartBeats(), t.loopBeats())) {
      this.click(ctx, now + (w.startEl + offset - w.nowEl) * spb, beat);
    }
  }

  /** The count-in: `beats` clicks from `start` (a performance.now() time), booked at once. */
  private countIn(start: number, beats: number) {
    this.engine.start();
    const ctx = this.engine.context;
    if (!ctx) return;
    const spb = 60 / this.transport.bpm();
    const t0 = ctx.currentTime + (start - performance.now()) / 1000;
    for (let i = 0; i < beats; i++) this.click(ctx, t0 + i * spb, i);
  }

  /** A short pitched blip at audio time `at`. */
  private click(ctx: AudioContext, at: number, beat: number) {
    if (at < ctx.currentTime - 0.01) return;
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.gain.value = 0.35;
      this.out.connect(ctx.destination);
    }
    const osc = ctx.createOscillator();
    osc.frequency.value = clickPitch(beat);
    const env = ctx.createGain();
    const peak = accented(beat) ? 1 : 0.6;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    osc.connect(env).connect(this.out);
    osc.start(at);
    osc.stop(at + 0.06);
    this.booked.push(osc);
    osc.onended = () => {
      env.disconnect();
      this.booked = this.booked.filter((o) => o !== osc);
    };
  }

  /** Stops clicks booked but not yet sounded (the count-in cancelled, CLICK switched off). */
  private dropBooked() {
    for (const o of this.booked) {
      try {
        o.stop();
      } catch {
        // already done
      }
    }
    this.booked = [];
  }
}
