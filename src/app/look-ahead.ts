import { beatDistance } from './core/schedule';
import type { Transport } from './transport';

/** A stretch of song to book now: positions [from, to) and where it sits in elapsed beats. */
export interface Window {
  from: number;
  to: number;
  /** Elapsed beats (counting on across the loop point since `reset`) at `from`, now and `to`. */
  startEl: number;
  nowEl: number;
  endEl: number;
}

/**
 * Walks a booking window along the song clock, `ahead` beats in front of the playhead, so
 * events can be scheduled on the audio clock before they're due (the MIDI track player and the
 * metronome). Each call to `next` hands over the stretch not booked yet.
 */
export class LookAhead {
  private nowPos = 0;
  private nowEl = 0;
  private schedPos = 0;
  private schedEl = 0;

  constructor(private readonly transport: Transport) {}

  /** Starts booking from the playhead (a hair before it, so an event right on it is booked). */
  reset() {
    this.nowPos = this.transport.beatNow();
    this.nowEl = 0;
    this.schedPos = Math.max(0, this.nowPos - 1e-6);
    this.schedEl = this.schedPos - this.nowPos;
  }

  next(ahead: number): Window | null {
    const t = this.transport;
    const [ls, le] = [t.loopStartBeats(), t.loopBeats()];
    const now = t.beatNow();
    const step = beatDistance(this.nowPos, now, ls, le);
    if (step > ahead + 1) {
      // A jump: a seek, a stalled tab, or the clock nudged back a hair by MIDI sync (which
      // reads as nearly a whole loop forward). A nudge keeps what's booked; anything else books
      // on from the new place rather than firing everything skipped at once.
      this.nowPos = now;
      const booked = beatDistance(now, this.schedPos, ls, le);
      if (booked > ahead * 2) {
        this.schedPos = now;
        this.schedEl = this.nowEl;
      } else this.schedEl = this.nowEl + booked;
      return null;
    }
    this.nowEl += step;
    this.nowPos = now;
    const endEl = this.nowEl + ahead;
    if (endEl <= this.schedEl) return null;
    const w: Window = {
      from: this.schedPos,
      to: t.wrap(now + ahead),
      startEl: this.schedEl,
      nowEl: this.nowEl,
      endEl,
    };
    this.schedPos = w.to;
    this.schedEl = endEl;
    return w;
  }
}
