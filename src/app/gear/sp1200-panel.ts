import { Component, computed, inject, input, signal } from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import type { Gear } from '../core/patch';
import {
  BANKS,
  DISK_FUNCTIONS,
  PAD_STEPS,
  PREAMPS,
  SAMPLE_FUNCTIONS,
  SETUP_FUNCTIONS,
  SYNC_FUNCTIONS,
  coarseOf,
  fineOf,
  lcdLine,
  parseStatus,
  region,
  sampleLength,
  thresholdLevel,
  withCoarse,
  withFine,
} from '../core/sp1200';
import { PatchStore } from '../patch-store';
import { Fader, Knob } from './controls';

type Module = 'setup' | 'disk' | 'sync' | 'sample';

/** A slider's job right now: which value it shows and how a move is stored. */
interface SliderJob {
  value: number;
  label: string;
  text?: string;
  set: (v: number) => void;
}

/** How long a "not yet" or confirmation message stays on the LCD. */
const NOTE_MS = 1800;
/** The Performance mode button's three positions, as stored in the `sliders` param. */
const MIX = 0;
const MULTI = 0.5;
const TUNE = 1;

const NOT_YET = 'not yet';
const pad5 = (n: number) => String(Math.max(0, Math.round(n))).padStart(5, '0');

/**
 * The SP-1200's front panel, laid out like the original: SET-UP, DISK, SYNC and SAMPLE modules
 * along the top, MASTER CONTROL (display, arrows, keypad, transport) on the right, PROGRAMMING
 * and PERFORMANCE (eight sliders over eight pads) below. Pressing a module's button activates it;
 * keying a number on the keypad then picks one of the functions printed beside it, as in the
 * owner's manual. The display prompts for each function, else shows the unit's own status.
 */
@Component({
  selector: 'kl-sp1200-panel',
  imports: [Fader, Knob],
  templateUrl: './sp1200-panel.html',
  styleUrl: './sp1200-panel.scss',
})
export class Sp1200Panel {
  readonly gear = input.required<Gear>();
  readonly preview = input(false);

  private readonly store = inject(PatchStore);
  private readonly engine = inject(AudioEngine);

  protected readonly setupList = SETUP_FUNCTIONS;
  protected readonly diskList = DISK_FUNCTIONS;
  protected readonly syncList = SYNC_FUNCTIONS;
  protected readonly sampleList = SAMPLE_FUNCTIONS;
  protected readonly banks = BANKS;
  protected readonly pads = [0, 1, 2, 3, 4, 5, 6, 7];
  /** PROGRAMMING buttons: the label above, the label below (shifted function), what it does. */
  protected readonly programming = [
    ['Trigger', 'Metronome'],
    ['Repeat', 'Swing'],
    ['Subsong', 'Copy'],
    ['End', 'Time Signature'],
    ['Insert', 'Segment Length'],
    ['Delete', 'Erase'],
    ['Tempo Change', 'Auto Correct'],
    ['Mix Change', 'Step Program'],
  ];

  /** The active module (its LED lit), the function keyed in, digits typed so far. */
  protected readonly module = signal<Module | null>(null);
  protected readonly fn = signal<number | null>(null);
  private readonly entry = signal('');
  /** SET-UP 19 / 20 waiting for YES or NO. */
  private readonly confirming = signal(false);
  /** The last way sampling was started, for SAMPLE 6 (re-sample). */
  private lastSampling: 'arm' | 'force' = 'force';
  /** Song / Segment mode LEDs (the sequencer isn't built yet, so this is only the light). */
  protected readonly songMode = signal(false);
  /** A short message on the display ("not yet", "Sound deleted"), cleared after a moment. */
  private readonly note = signal<[string, string] | null>(null);
  private noteTimer?: ReturnType<typeof setTimeout>;

  private readonly params = computed(() => this.gear().params);
  protected readonly bank = computed(() => BANKS[Math.round(this.value('bank') * 3)]);
  protected readonly padIndex = computed(() => Math.round(this.value('pad') * 7));
  /** The selected sound location (the last pad pressed), e.g. B3. */
  protected readonly current = computed(() => `${this.bank()}${this.padIndex() + 1}`);
  protected readonly mode = computed(() => {
    const v = this.value('sliders');
    return v >= 0.75 ? 'tune' : v >= 0.25 ? 'multi' : 'mix';
  });
  private readonly status = computed(() => parseStatus(this.engine.statuses()[this.gear().id]));
  protected readonly sampling = computed(() => (this.status()?.phase ?? 'idle') !== 'idle');
  protected readonly hasKeyboard = computed(() => this.engine.keyboardSynth() === this.gear().id);
  private readonly heldSteps = computed(() => {
    const base = this.engine.base();
    return new Set((this.engine.held()[this.gear().id] ?? []).map((n) => n - base));
  });
  private readonly channel = computed(() => Math.round(this.value('ch' + this.current()) * 7) + 1);
  private readonly lengthText = computed(() => `${sampleLength(this.value('length')).toFixed(1)}s`);
  private readonly thresholdText = computed(
    () => `${Math.round(20 * Math.log10(thresholdLevel(this.value('threshold'))))}dB`,
  );
  private readonly preampText = computed(
    () => PREAMPS[Math.round(this.value('preamp') * (PREAMPS.length - 1))],
  );

  /** The two display lines. */
  protected readonly lcd = computed(() => {
    const [a, b] = this.screen();
    return `${lcdLine(a)}\n${lcdLine(b)}`;
  });

  private screen(): [string, string] {
    const note = this.note();
    if (note) return note;
    const st = this.status();
    if (st && st.phase !== 'idle') return [st.top, st.vu]; // Sample Armed / Sampling...
    const id = this.current();
    const unit: [string, string] = st ? [st.top, st.vu] : [id, 'AUDIO OFF'];
    const fn = this.fn();
    switch (this.module()) {
      case 'sample':
        switch (fn) {
          case 2:
            return [`Assign Voice ${id}${st?.length ? '*' : ''}`, `Output Ch ${this.channel()}`];
          case 3:
            return [`Level ${this.preampText()}`, unit[1]];
          case 4:
            return [`Thresh ${this.thresholdText()}`, unit[1]];
          case 5:
            return [`Length ${this.lengthText()}`, `Avail ${(st?.free ?? 2.5).toFixed(1)}s`];
          default:
            return unit; // VU mode (SAMPLE 1)
        }
      case 'setup':
        switch (fn) {
          case 17:
            return [`Ch Assign ${id}`, `Channel ${this.channel()} (1-8)`];
          case 18:
            return [
              `${id} ${this.value('dmode' + id) >= 0.5 ? 'DECAYED' : 'TUNED'}`,
              '1=Tune 2=Decay',
            ];
          case 19: {
            const len = st?.length ?? 0;
            if (!len) return [`${id} is empty`, 'Pick a sound'];
            if (this.confirming()) return ['Make Truncation', 'Permanent? Y/N'];
            const r = region(
              len,
              this.value('start' + id),
              this.value('end' + id),
              this.value('loop' + id),
            );
            return [
              `S=${pad5(r.start)} ${id}`,
              `E=${pad5(r.end)} L=${r.loop ? pad5(r.loop) : 'NONE'}`,
            ];
          }
          case 20:
            return st && !st.length
              ? [`${id} is empty`, 'Pick a sound']
              : [`Delete ${id}?`, 'Yes / No'];
          default:
            return ['Set-up Function?', `Key 11-23  ${this.entry()}`];
        }
      case 'disk':
        return ['Disk Function?', 'No drive yet'];
      case 'sync':
        return ['Sync: Internal', 'Key 1-4'];
      default:
        return unit;
    }
  }

  /** What each slider does: SET-UP 19 and SAMPLE 4 / 5 borrow sliders, else MIX or TUNE/DECAY. */
  protected readonly sliders = computed<SliderJob[]>(() => {
    const id = this.current();
    const m = this.module();
    const fn = this.fn();
    return this.pads.map((i) => {
      if (m === 'setup' && fn === 19 && i < 6) {
        const key = ['start', 'end', 'loop'][i >> 1] + id;
        const coarse = i % 2 === 0;
        const v = this.value(key);
        const name = `${['START', 'END', 'LOOP'][i >> 1]} ${coarse ? 'COARSE' : 'FINE'}`;
        return {
          value: coarse ? coarseOf(v) : fineOf(v),
          label: `Slider ${i + 1}: ${name} ${id}`,
          set: (x) =>
            this.set(key, coarse ? withCoarse(this.value(key), x) : withFine(this.value(key), x)),
        };
      }
      if (m === 'sample' && i === 0 && (fn === 4 || fn === 5)) {
        const key = fn === 4 ? 'threshold' : 'length';
        return {
          value: this.value(key),
          label: `Slider 1: ${fn === 4 ? 'THRESHOLD' : 'SAMPLE LENGTH'}`,
          text: fn === 4 ? this.thresholdText() : this.lengthText(),
          set: (x) => this.set(key, x),
        };
      }
      const tune = this.mode() === 'tune';
      const key = `${tune ? 'tune' : 'lvl'}${this.bank()}${i + 1}`;
      const decay = this.value(`dmode${this.bank()}${i + 1}`) >= 0.5;
      return {
        value: this.value(key),
        label: `Slider ${i + 1}: ${tune ? (decay ? 'DECAY' : 'TUNE') : 'MIX'} ${this.bank()}${i + 1}`,
        set: (x) => this.set(key, x),
      };
    });
  });

  protected value(param: string): number {
    return this.params()[param] ?? 0;
  }

  private set(param: string, v: number) {
    if (!this.preview()) this.store.setParam(this.gear().id, param, Math.min(1, Math.max(0, v)));
  }

  private command(name: string) {
    if (!this.preview()) this.engine.command(this.gear().id, name);
  }

  private say(top: string, bottom = NOT_YET) {
    clearTimeout(this.noteTimer);
    this.note.set([top, bottom]);
    this.noteTimer = setTimeout(() => this.note.set(null), NOTE_MS);
  }

  private reset(module: Module | null = this.module()) {
    this.module.set(module);
    this.fn.set(null);
    this.entry.set('');
    this.confirming.set(false);
  }

  // ── Modules ───────────────────────────────────────────

  /** A module button: activates it (pressing it again, or another, leaves it). */
  protected pressModule(m: Module) {
    if (this.sampling() && m === 'sample') {
      this.command('stop');
      return this.say('Sampling stopped', '');
    }
    this.note.set(null);
    this.reset(this.module() === m ? null : m);
  }

  /** The numeric keypad: picks a module function, or enters a value for the function. */
  protected key(n: number) {
    const fn = this.fn();
    // 7 doubles as NO and 9 as YES (printed under them) while the display asks a question.
    if (this.asking()) {
      if (n === 9) return this.yes();
      if (n === 7) return this.no();
      return;
    }
    switch (this.module()) {
      case 'sample':
        if (fn === 2 && n >= 1 && n <= 8) return this.set('ch' + this.current(), (n - 1) / 7);
        return this.sampleFunction(n);
      case 'setup':
        if (fn === 17 && n >= 1 && n <= 8) return this.set('ch' + this.current(), (n - 1) / 7);
        if (fn === 18 && (n === 1 || n === 2)) return this.set('dmode' + this.current(), n - 1);
        if (fn !== null) return;
        return this.setupDigit(n);
      case 'disk': {
        const f = DISK_FUNCTIONS.find((d) => d.key === n);
        return this.say(f ? f.name : `No Disk ${n}`);
      }
      case 'sync': {
        const f = SYNC_FUNCTIONS.find((d) => d.key === n);
        if (n === 1) return this.say('Sync Internal', 'selected');
        return this.say(f ? `Sync ${f.name}` : `No Sync ${n}`);
      }
      default:
        return this.say(`Segment ${n}`);
    }
  }

  private sampleFunction(n: number) {
    switch (n) {
      case 1:
        return this.fn.set(null); // VU mode
      case 2:
      case 3:
      case 4:
      case 5:
        return this.fn.set(n);
      case 6:
        return this.startSampling(this.lastSampling);
      case 7:
        return this.startSampling('arm');
      case 9:
        return this.startSampling('force');
      default:
        return this.say(`No Sample ${n}`, '');
    }
  }

  private startSampling(how: 'arm' | 'force') {
    if (!this.status()) return this.say('Turn AUDIO on', 'to sample');
    this.lastSampling = how;
    this.fn.set(null);
    this.command(how);
  }

  private setupDigit(n: number) {
    const typed = this.entry() + n;
    if (typed.length < 2) return this.entry.set(typed);
    this.entry.set('');
    const k = Number(typed);
    const f = SETUP_FUNCTIONS.find((s) => s.key === k);
    if (!f) return this.say(`No Set-up ${typed}`, 'Key 11-23');
    if (k >= 17 && k <= 20) return this.fn.set(k);
    this.say(f.name);
  }

  /** SET-UP 19 "Make Truncation Permanent?" and SET-UP 20 "Delete?" wait for YES / NO. */
  private asking() {
    const fn = this.fn();
    return this.module() === 'setup' && ((fn === 19 && this.confirming()) || fn === 20);
  }

  protected keyTitle(n: number): string {
    const dual = n === 7 ? ' / NO' : n === 9 ? ' / YES' : '';
    return `Key ${n}${dual}: picks a function of the active module, or enters a value`;
  }

  private yes() {
    const id = this.current();
    if (this.module() === 'setup' && this.fn() === 19 && this.confirming()) {
      this.truncate();
      this.reset();
      return this.say('Truncation', 'made permanent');
    }
    if (this.module() === 'setup' && this.fn() === 20 && this.status()?.length) {
      this.command('erase');
      this.reset();
      return this.say(`${id} deleted`, '');
    }
    this.say('Yes');
  }

  private no() {
    if (this.module() === 'setup' && (this.fn() === 19 || this.fn() === 20)) {
      const kept = this.fn() === 19 && this.confirming();
      this.reset();
      if (kept) this.say('Truncation kept', 'full sound held');
      return;
    }
    this.say('No');
  }

  protected enter() {
    const m = this.module();
    const fn = this.fn();
    if (m === 'sample' && fn !== null) return this.fn.set(null); // back to VU mode
    if (m === 'setup' && (fn === 17 || fn === 18)) return this.reset();
    if (m === 'setup' && fn === 19) {
      if (this.status()?.length) this.confirming.set(true);
      return;
    }
    this.say('Enter');
  }

  /** ◀ ▶: preamp gain (SAMPLE 3), sample length (SAMPLE 5), output channel (SAMPLE 2 / SET-UP 17). */
  protected arrow(dir: number) {
    const m = this.module();
    const fn = this.fn();
    if (m === 'sample' && fn === 3) {
      const steps = PREAMPS.length - 1;
      return this.set('preamp', (Math.round(this.value('preamp') * steps) + dir) / steps);
    }
    if (m === 'sample' && fn === 5) {
      return this.set('length', (Math.round(this.value('length') * 24) + dir) / 24);
    }
    if ((m === 'sample' && fn === 2) || (m === 'setup' && fn === 17)) {
      const key = 'ch' + this.current();
      return this.set(key, (Math.round(this.value(key) * 7) + dir) / 7);
    }
    this.say(dir < 0 ? '◀ Back' : 'Forward ▶');
  }

  /** SET-UP 19 "Make Truncation Permanent": the sliders then describe the shortened sound. */
  private truncate() {
    const id = this.current();
    const [s, e, l] = ['start', 'end', 'loop'].map((k) => this.value(k + id));
    this.command('truncate');
    this.set('start' + id, 0);
    this.set('end' + id, 1);
    this.set('loop' + id, e > s ? Math.min(1, l / (e - s)) : 0);
  }

  // ── Master control / programming (sequencer not built yet) ──

  protected runStop() {
    if (this.sampling()) {
      this.command('stop');
      return this.say('Sampling stopped', '');
    }
    this.say('Run/Stop');
  }

  protected notYet(name: string) {
    this.say(name);
  }

  protected songSegment() {
    this.songMode.update((s) => !s);
    this.say(this.songMode() ? 'Song mode' : 'Segment mode');
  }

  // ── Performance ───────────────────────────────────────

  /** The mode button steps TUNE/DECAY → MIX → MULTI MODE. */
  protected cycleMode() {
    const next = { tune: MIX, mix: MULTI, multi: TUNE }[this.mode()];
    this.set('sliders', next);
    if (next === MULTI) this.say('Multi Mode', 'not yet: MIX');
  }

  protected cycleBank() {
    this.set('bank', ((Math.round(this.value('bank') * 3) + 1) % 4) / 3);
  }

  protected padSelected(i: number) {
    return this.padIndex() === i;
  }

  protected padHeld(i: number) {
    return this.heldSteps().has(PAD_STEPS[i]);
  }

  protected padDecay(i: number) {
    return this.value(`dmode${this.bank()}${i + 1}`) >= 0.5;
  }

  /** A pad plays its sound and selects it for sampling and editing. */
  protected padDown(e: PointerEvent, i: number) {
    e.stopPropagation();
    if (this.preview()) return;
    this.set('pad', i / 7);
    const id = this.gear().id;
    const note = this.engine.base() + PAD_STEPS[i];
    this.engine.noteOn(note, id);
    const pid = e.pointerId;
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return; // another finger on another pad
      this.engine.noteOff(note, id);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  protected knob(param: string, v: number) {
    this.set(param, v);
  }
}
