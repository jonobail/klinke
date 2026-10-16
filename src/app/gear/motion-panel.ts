import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { GEAR, type ParamDef, defaultParams } from '../core/gear';
import {
  PATTERN_STEPS,
  PRESETS,
  STEP_MAX,
  AUTO_DIVS,
  decodeStatus,
  dice,
  motionSettings,
  parsePattern,
} from '../core/motion';
import type { Gear } from '../core/patch';
import { PatchStore } from '../patch-store';
import { Knob, Rocker } from './controls';

interface Section {
  title: string;
  rows: string[][];
  cls?: string;
}

/** The knob sections along the bottom of the face, left to right. */
const LOWER: Section[] = [
  { title: 'VOICES', rows: [['voices', 'leading'], ['legato']] },
  {
    title: 'GLIDE',
    rows: [
      ['glideMode', 'glide', 'curve', 'spread'],
      ['stagger', 'staggerAmt', 'path', 'pathDepth'],
    ],
  },
  {
    title: 'START · RELEASE',
    rows: [
      ['start', 'startAmt'],
      ['release', 'releaseAmt', 'releaseTime'],
    ],
  },
  {
    title: 'EXPRESSION',
    rows: [
      ['swell', 'wander', 'drift'],
      ['vibDelay', 'vibRate', 'vibDepth'],
    ],
  },
  {
    title: 'MODULATORS',
    rows: [
      ['mod1Rate', 'mod1Dest', 'mod1Depth'],
      ['mod2Rate', 'mod2Dest', 'mod2Depth', 'modSpread'],
    ],
  },
];

const AUTO: Section = {
  title: 'AUTOPILOT',
  rows: [
    ['auto', 'autoRate', 'autoSync'],
    ['autoLoop', 'autoDepth'],
  ],
};
const BEND: Section = {
  title: 'GLOBAL BEND',
  rows: [
    ['bendShape', 'bendLength'],
    ['bendDepth', 'bendLoop'],
  ],
};

/** Short names printed under the knobs (the full name is in the tooltip). */
const SHORT: Record<string, string> = {
  leading: 'LEAD',
  glideMode: 'MODE',
  staggerAmt: 'TIME',
  pathDepth: 'DEPTH',
  startAmt: 'BEND',
  releaseAmt: 'BEND',
  releaseTime: 'TIME',
  wander: 'WANDER',
  vibDelay: 'VIB DLY',
  vibRate: 'VIB RATE',
  vibDepth: 'VIB DEP',
  auto: 'MODE',
  autoRate: 'RATE',
  autoSync: 'SYNC',
  autoLoop: 'LOOP',
  autoDepth: 'AMOUNT',
  bendShape: 'SHAPE',
  bendLength: 'LENGTH',
  bendDepth: 'DEPTH',
  bendLoop: 'LOOP',
  mod1Rate: '1 RATE',
  mod1Dest: '1 DEST',
  mod1Depth: '1 DEPTH',
  mod2Rate: '2 RATE',
  mod2Dest: '2 DEST',
  mod2Depth: '2 DEPTH',
  modSpread: 'SPREAD',
};

/** Voice-line colours, by voice id. */
const COLOURS = ['#5ce1e6', '#ffb347', '#ff6f91', '#b8f35a', '#c39bff', '#ffe066', '#6fa8ff'];
/** Seconds of history the display shows. */
const SPAN = 4;
const W = 192;
const H = 112;

interface Sample {
  t: number;
  voices: { id: number; pitch: number; pressure: number; releasing: boolean }[];
}

/**
 * The MOTION-15 face: a header with the preset display, ◀ ▶ and DICE; the voice-line display
 * (every voice's pitch over the last few seconds), the AUTOPILOT with its 8-step pattern and the
 * GLOBAL BEND; then VOICES, GLIDE, START · RELEASE, EXPRESSION and MODULATORS along the bottom.
 * NOTE IN on the left edge, NOTE OUT on the right.
 */
@Component({
  selector: 'kl-motion-panel',
  imports: [NgTemplateOutlet, Knob, Rocker],
  templateUrl: './motion-panel.html',
  styleUrl: './motion-panel.scss',
})
export class MotionPanel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  protected readonly engine = inject(AudioEngine);
  private readonly store = inject(PatchStore);
  private readonly def = computed(() => GEAR[this.gear().kind]);
  private readonly params = computed(() => new Map(this.def().params.map((d) => [d.id, d])));
  protected readonly settings = computed(() => motionSettings(this.gear().params));
  protected readonly LOWER = LOWER;
  protected readonly AUTO = AUTO;
  protected readonly BEND = BEND;
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  protected readonly jacks = computed(() => this.def().jacks);
  protected readonly pattern = computed(() => parsePattern(this.gear().text?.['pattern']));
  protected readonly STEPS = Array.from({ length: PATTERN_STEPS }, (_, i) => i);
  protected readonly STEP_MAX = STEP_MAX;
  private readonly status = computed(() => decodeStatus(this.engine.statuses()[this.gear().id]));
  protected readonly step = computed(() => this.status().step);
  protected readonly voiceCount = computed(
    () => this.status().voices.filter((v) => !v.releasing).length,
  );
  private readonly presetIndex = signal(-1);
  protected readonly display = signal('');

  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('lines');
  private history: Sample[] = [];

  constructor() {
    effect(() => {
      const st = this.status();
      const el = this.canvas()?.nativeElement;
      if (!el) return;
      const t = performance.now() / 1000;
      if (this.preview()) this.history = demoHistory(t);
      else {
        this.history.push({ t, voices: st.voices });
        while (this.history.length && this.history[0].t < t - SPAN - 0.2) this.history.shift();
      }
      draw(el, this.history, t);
    });
  }

  protected headline = computed(() => {
    const d = this.display();
    if (d) return d;
    const s = this.settings();
    const auto = s.auto === 'OFF' ? 'AUTO OFF' : `${s.auto}`;
    return `${s.voices} VOICES · ${s.leading} · ${auto}`;
  });

  protected value(id: string): number {
    return this.gear().params[id] ?? 0;
  }

  protected param(id: string): ParamDef {
    return this.params().get(id)!;
  }

  protected short(id: string) {
    return SHORT[id] ?? this.param(id).label;
  }

  /** Tooltip text, in the units the knob means. */
  protected valueText(id: string): string | undefined {
    const p = this.param(id);
    const v = this.value(id);
    if (p.options && p.steps) return p.options[Math.round(v * (p.steps - 1))];
    const s = this.settings();
    const sec = (x: number) => (x < 1 ? `${Math.round(x * 1000)} ms` : `${x.toFixed(2)} s`);
    switch (id) {
      case 'legato':
        return sec(s.legato);
      case 'glide':
        return s.rateMode ? `${s.glide.toFixed(1)} st/s` : sec(s.glide);
      case 'spread':
        return `±${Math.round(s.spread * 75)} %`;
      case 'staggerAmt':
        return sec(s.staggerTime);
      case 'pathDepth':
        return `${s.pathDepth.toFixed(1)} st`;
      case 'startAmt':
        return `${s.startBend.toFixed(1)} st`;
      case 'releaseAmt':
        return `${s.releaseBend.toFixed(1)} st`;
      case 'releaseTime':
        return sec(s.releaseTime);
      case 'swell':
        return s.swell ? sec(s.swell) : 'OFF';
      case 'vibDelay':
        return sec(s.vibDelay);
      case 'vibRate':
        return `${s.vibRate.toFixed(1)} Hz`;
      case 'vibDepth':
        return `${Math.round(s.vibDepth * 100)} cent`;
      case 'drift':
        return `${Math.round(s.drift)} cent`;
      case 'autoRate':
        return s.autoSync
          ? `${AUTO_DIVS.find(([, b]) => b === s.autoBeats)?.[0]} / step`
          : `${s.autoHz.toFixed(2)} steps/s`;
      case 'bendDepth':
        return `${s.bendDepth >= 0 ? '+' : ''}${s.bendDepth.toFixed(1)} st`;
      case 'mod1Rate':
      case 'mod2Rate':
        return `${s.mods[id === 'mod1Rate' ? 0 : 1].rate.toFixed(2)} Hz`;
    }
    return undefined;
  }

  protected set(id: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, id, v);
  }

  protected isRocker(id: string) {
    return !!this.param(id).rocker;
  }

  protected rockerColour(id: string) {
    return this.param(id).rocker ?? 'white';
  }

  // ── Presets and dice ──────────────────────────────────

  protected preset(dir: number) {
    if (this.preview()) return;
    const n = PRESETS.length;
    const i = (((this.presetIndex() + dir) % n) + n) % n;
    this.presetIndex.set(i);
    const pr = PRESETS[i];
    const base = defaultParams('motion');
    const keep = new Set(['voices', 'leading']);
    for (const [id, v] of Object.entries({ ...base, ...pr.params }))
      if (!keep.has(id) && v !== this.value(id)) this.set(id, v);
    this.savePattern(pr.pattern ?? parsePattern(undefined));
    this.flash(pr.name);
  }

  protected roll() {
    if (this.preview()) return;
    const d = dice(Math.random);
    for (const [id, v] of Object.entries(d.params)) this.set(id, v);
    this.savePattern(d.pattern);
    this.presetIndex.set(-1);
    this.flash('DICE!');
  }

  private flashTimer?: ReturnType<typeof setTimeout>;
  private flash(text: string) {
    this.display.set(text);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.display.set(''), 1600);
  }

  // ── Pattern editor ────────────────────────────────────

  private savePattern(pattern: number[]) {
    if (!this.preview()) this.store.setText(this.gear().id, 'pattern', JSON.stringify(pattern));
  }

  /** Click or drag in a step's column to set it: top +7, middle 0, bottom −7. */
  protected stepDown(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (this.preview() || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const pid = e.pointerId;
    const box = el.getBoundingClientRect();
    let pat = this.pattern().slice();
    const at = (m: PointerEvent) => {
      const i = Math.floor(((m.clientX - box.left) / box.width) * PATTERN_STEPS);
      const y = 1 - (m.clientY - box.top) / box.height; // 0 bottom … 1 top
      const v = Math.round((y * 2 - 1) * STEP_MAX);
      if (i < 0 || i >= PATTERN_STEPS) return;
      const nv = Math.max(-STEP_MAX, Math.min(STEP_MAX, v));
      if (pat[i] === nv) return;
      pat = pat.slice();
      pat[i] = nv;
      this.savePattern(pat);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== pid) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    const move = (m: PointerEvent) => m.pointerId === pid && at(m);
    at(e);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  protected stepWheel(e: WheelEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    if (this.preview()) return;
    const pat = this.pattern().slice();
    pat[i] = Math.max(-STEP_MAX, Math.min(STEP_MAX, pat[i] - Math.sign(e.deltaY)));
    this.savePattern(pat);
  }

  protected barStyle(v: number) {
    const h = (Math.abs(v) / STEP_MAX) * 50;
    return v >= 0 ? { bottom: '50%', height: `${h}%` } : { top: '50%', height: `${h}%` };
  }
}

/** The voice-line display: one line per voice, pitch up the screen, time to the left. */
function draw(el: HTMLCanvasElement, history: Sample[], now: number) {
  const g = el.getContext('2d');
  if (!g) return;
  g.fillStyle = '#0b0a16';
  g.fillRect(0, 0, W, H);
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of history)
    for (const v of s.voices) {
      lo = Math.min(lo, v.pitch);
      hi = Math.max(hi, v.pitch);
    }
  if (!Number.isFinite(lo)) {
    lo = 48;
    hi = 72;
  }
  const mid = (lo + hi) / 2;
  const span = Math.max(24, hi - lo + 6);
  lo = mid - span / 2;
  const y = (pitch: number) => H - 2 - ((pitch - lo) / span) * (H - 4);
  const x = (t: number) => W - 1 - ((now - t) / SPAN) * (W - 2);
  // Octave lines on each C, a dotted line every second.
  g.fillStyle = '#25213f';
  for (let c = Math.ceil(lo / 12) * 12; c < lo + span; c += 12)
    g.fillRect(0, Math.round(y(c)), W, 1);
  g.fillStyle = '#1a1730';
  for (let s = 1; s < SPAN; s++)
    for (let yy = 0; yy < H; yy += 3) g.fillRect(Math.round(x(now - s)), yy, 1, 1);
  // Voices: a line through each voice's samples, pressure brightening it.
  const lines = new Map<number, { x: number; y: number; a: number }[]>();
  for (const s of history)
    for (const v of s.voices) {
      let l = lines.get(v.id);
      if (!l) lines.set(v.id, (l = []));
      l.push({ x: x(s.t), y: y(v.pitch), a: v.releasing ? 0.35 : 0.45 + v.pressure * 0.55 });
    }
  for (const [id, pts] of lines) {
    g.strokeStyle = COLOURS[id % COLOURS.length];
    g.lineWidth = 1;
    for (let i = 1; i < pts.length; i++) {
      g.globalAlpha = pts[i].a;
      g.beginPath();
      g.moveTo(Math.round(pts[i - 1].x) + 0.5, Math.round(pts[i - 1].y) + 0.5);
      g.lineTo(Math.round(pts[i].x) + 0.5, Math.round(pts[i].y) + 0.5);
      g.stroke();
    }
    const last = pts[pts.length - 1];
    g.globalAlpha = 1;
    g.fillStyle = COLOURS[id % COLOURS.length];
    if (last.x > W - 6) g.fillRect(Math.round(last.x) - 2, Math.round(last.y) - 1, 3, 3);
  }
  g.globalAlpha = 1;
}

/** For the shelf preview: a triad morphing into another, drawn rather than played. */
function demoHistory(now: number): Sample[] {
  const out: Sample[] = [];
  const a = [55, 60, 64];
  const b = [57, 62, 65];
  for (let i = 0; i <= 60; i++) {
    const t = now - SPAN + (i / 60) * SPAN;
    const x = Math.min(1, Math.max(0, (i - 25) / 15));
    const k = x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    out.push({
      t,
      voices: a.map((p, v) => ({
        id: v + 1,
        pitch: p + (b[v] - p) * k + Math.sin(i * 0.6 + v) * 0.15 * (i > 45 ? 1 : 0),
        pressure: 0.8,
        releasing: false,
      })),
    });
  }
  return out;
}
