// VIDEO DECK: a YouTube video's audio as a patchable source.
//
//   link → video ID → <audio src="/api/yt/audio?v=…"> → MediaElementSource → LEVEL → OUT
//
// The media helper (server/media-server.mjs) relays the audio-only stream same-origin, so Web
// Audio may tap it; once wrapped in a MediaElementSource the element is heard only through the
// patch. The browser fetches it in ranges as it plays and seeks; nothing is saved anywhere.

import { clock, startTime, videoId } from '../core/youtube';
import { faderGain } from '../core/sound';
import { type Params, Unit, glide } from './unit';

export class DeckUnit extends Unit {
  private readonly el = new Audio();
  private readonly source = this.ctx.createMediaElementSource(this.el);
  private readonly level = this.ctx.createGain();
  private id: string | null = null;
  private title = '';
  private problem = '';
  /** Where the link says to start (`t=`), in seconds. */
  private start = 0;

  constructor(ctx: AudioContext) {
    super(ctx);
    this.el.preload = 'metadata';
    this.source.connect(this.level);
    this.output = this.level;
    this.el.addEventListener('error', () => {
      if (this.id) void this.explain(this.id);
    });
  }

  set(p: Params) {
    glide(this.level.gain, faderGain(p['level']), this.ctx);
    this.el.loop = p['loop'] >= 0.5;
  }

  override setText(text: Record<string, string>) {
    const link = text['link'] ?? '';
    const id = videoId(link);
    this.start = startTime(link);
    if (id === this.id) return;
    this.id = id;
    this.el.pause();
    this.problem = '';
    if (!id) {
      this.title = link.trim() ? 'Not a YouTube link' : '';
      this.el.removeAttribute('src');
      this.el.load();
      return;
    }
    this.title = 'Loading…';
    this.el.src = `/api/yt/audio?v=${id}`;
    if (this.start) this.el.currentTime = this.start;
    fetch(`/api/yt/info?v=${id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (this.id !== id) return;
        if (res.ok) this.title = String(body.title ?? id);
        else void this.explain(id, body.error);
      })
      .catch(() => this.explain(id));
  }

  override command(name: string) {
    if (!this.id) return;
    if (name === 'play') void this.el.play().catch(() => this.explain(this.id!));
    else if (name === 'pause') this.el.pause();
    else if (name === 'toggle') this.command(this.el.paused ? 'play' : 'pause');
    else if (name === 'stop') {
      this.el.pause();
      this.el.currentTime = this.start;
    } else if (name.startsWith('seek:')) {
      const t = Number(name.slice(5));
      if (Number.isFinite(t)) this.el.currentTime = Math.max(0, t);
    }
  }

  /** Why it won't play: the helper isn't running, or the helper's own message. */
  private async explain(id: string, message?: string) {
    if (this.id !== id) return;
    if (!message) {
      const health = await fetch('/api/health')
        .then((r) => r.ok)
        .catch(() => false);
      message = health ? 'Can’t play this video' : 'Helper offline: npm run server';
    }
    if (this.id === id) this.problem = message;
  }

  /**
   * Three lines: the title (or what's wrong), "▶ 1:23 / 4:56", and "position duration playing"
   * for the panel's scrub bar.
   */
  override status(): string | null {
    if (!this.id && !this.title) return 'Paste a YouTube link\n■ --:-- / --:--\n0 0 0';
    const t = this.el.currentTime;
    const d = Number.isFinite(this.el.duration) ? this.el.duration : 0;
    const playing = !this.el.paused && !this.el.ended;
    // ▶ playing, … waiting for data, ■ stopped, ! problem
    const state = this.problem ? '!' : playing ? (this.el.readyState < 3 ? '…' : '▶') : '■';
    return `${this.problem || this.title}\n${state} ${clock(t)} / ${clock(d)}\n${t} ${d} ${playing ? 1 : 0}`;
  }

  override dispose() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.source.disconnect();
    super.dispose();
  }
}
