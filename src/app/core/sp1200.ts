// SP-1200 maths, after the owner's manual (Part 1 setup, Part 4 sampling, §1M outputs) and the
// EMU-SP1200 hardware notes (github.com/Lytrix/EMU-SP1200: 26.04 kHz clock, 12-bit words, pitch by
// skipping / doubling samples). Pure TypeScript so it runs under node --test.

/** Sample clock. The manual rounds it to "26,000 samples" a second. */
export const RATE = 26040;
/** Four 2.5 s memory zones (§4E): a sound can't cross from one zone into the next. */
export const ZONES = 4;
export const ZONE_SECONDS = 2.5;
export const ZONE_SAMPLES = Math.round(ZONE_SECONDS * RATE);
export const BANKS = ['A', 'B', 'C', 'D'] as const;
export const PADS = 8;
/** Sound locations A1…D8. */
export const SOUND_IDS = BANKS.flatMap((b) =>
  Array.from({ length: PADS }, (_, i) => `${b}${i + 1}`),
);

/** Output channel filtering (§1M): 1–2 dynamic, 3–6 fixed, 7–8 unfiltered. */
export type ChannelFilter = 'dynamic' | 'fixed' | 'none';
export const channelFilter = (ch: number): ChannelFilter =>
  ch <= 2 ? 'dynamic' : ch <= 6 ? 'fixed' : 'none';

/** Preamp gains (SAMPLE 3): +00 dB for line, +20 for instruments, +40 for mics. */
export const PREAMPS = ['+00dB', '+20dB', '+40dB'];
export const preampGain = (index: number) => [1, 10, 100][index] ?? 1;

/** SAMPLE 5: 0.1–2.5 s in 0.1 s steps. */
export const sampleLength = (v: number) => Math.round(1 + v * 24) / 10;

/** SAMPLE 4 threshold as a linear level, from -60 dB (slider down) to 0 dB. */
export const thresholdLevel = (v: number) => Math.pow(10, (-60 + v * 60) / 20);

/** TUNE slider: plus or minus a fifth (§1F). */
export const tuneSemitones = (v: number) => (v * 2 - 1) * 7;
export const pitchRatio = (v: number) => Math.pow(2, tuneSemitones(v) / 12);

/**
 * DECAY slider (§1F): the centre is the sound's own decay; down shortens it to a click, up
 * lengthens it (which only shows on looped sounds). Seconds for the level to fall 60 dB.
 */
export function decaySeconds(v: number, natural: number): number {
  if (v <= 0.5) return 0.02 * Math.pow(natural / 0.02, v * 2);
  return natural * Math.pow(8, (v - 0.5) * 2);
}

/** 12-bit quantisation to the converter's 4096 levels, clipping at full scale. */
export function quantize12(x: number): { value: number; clipped: boolean } {
  const clipped = x >= 1 || x < -1;
  const c = Math.max(-1, Math.min(2047 / 2048, x));
  return { value: Math.round(c * 2048) / 2048, clipped };
}

/**
 * Captured audio → SP-1200 memory: pick the sample nearest each 26.04 kHz clock tick (the
 * converter's sample-and-hold; the input is low-passed before it reaches here) and quantise to
 * 12 bits. Reports overload as "Sample Overload" does (§4F).
 */
export function toSpMemory(
  src: Float32Array,
  srcRate: number,
): { data: Float32Array; overload: boolean } {
  const n = Math.floor((src.length * RATE) / srcRate);
  const data = new Float32Array(n);
  let overload = false;
  for (let i = 0; i < n; i++) {
    const q = quantize12(src[Math.min(src.length - 1, Math.floor((i * srcRate) / RATE))]);
    data[i] = q.value;
    overload ||= q.clipped;
  }
  return { data, overload };
}

export interface Region {
  start: number; // first sample played
  end: number; // one past the last
  loop: number; // loop length in samples, 0 = none (the loop ends at `end`, §4H)
}

/** Truncation / loop knobs (0–1) → sample positions, never shorter than the loop (§4H step 9). */
export function region(length: number, start: number, end: number, loop: number): Region {
  const s = Math.floor(start * length);
  const e = Math.max(s + 1, Math.ceil(end * length));
  const l = Math.min(Math.floor(loop * length), e - s);
  return { start: s, end: e, loop: l };
}

/**
 * Plays a sound the way the SP-1200 pitches it: on every 26.04 kHz tick the read address steps by
 * the pitch ratio and the integer part is used, so samples are skipped (up) or repeated (down) with
 * no interpolation. Each tick's value is held until the next (zero-order hold) at the output rate,
 * keeping the converter's images: the grit the output filters then tame (or don't, on 7–8).
 */
export function renderPitched(
  data: Float32Array,
  ratio: number,
  outRate: number,
  r: Region = { start: 0, end: data.length, loop: 0 },
  maxSeconds = 4,
): Float32Array<ArrayBuffer> {
  const ticks: number[] = [];
  let pos = r.start;
  const maxTicks = Math.floor(maxSeconds * RATE);
  while (ticks.length < maxTicks) {
    let i = Math.floor(pos);
    if (i >= r.end) {
      if (!r.loop) break;
      pos -= r.loop * Math.ceil((pos - r.end + 1) / r.loop);
      i = Math.floor(pos);
    }
    ticks.push(data[i]);
    pos += ratio;
  }
  const out = new Float32Array(Math.ceil((ticks.length * outRate) / RATE));
  for (let j = 0; j < out.length; j++)
    out[j] = ticks[Math.min(ticks.length - 1, Math.floor((j * RATE) / outRate))];
  return out;
}

/** The first zone with room for `samples`, or -1 (sounds can't cross zones, §4E). */
export function fitZone(used: number[], samples: number): number {
  return used.findIndex((u) => u + samples <= ZONE_SAMPLES);
}

/** Room for the next sample: the largest free space in any one zone, in seconds (§4E, SPECIAL 13). */
export const largestFree = (used: number[]) =>
  Math.max(0, ...used.map((u) => ZONE_SAMPLES - u)) / RATE;

/**
 * Pads from keys: the computer keyboard's home row A S D F G H J K (C D E F G A B C above the
 * keyboard's base C) plays pads 1–8, the same for MIDI notes. Black keys don't play pads.
 */
export const PAD_STEPS = [0, 2, 4, 5, 7, 9, 11, 12];
export const padForStep = (step: number) => PAD_STEPS.indexOf(step);

/** Index of the first sample whose level passes the threshold, or -1 (SAMPLE 7, armed). */
export function thresholdIndex(samples: Float32Array, level: number): number {
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= level) return i;
  return -1;
}

// ── Stand-in kit for bank A ─────────────────────────────
// The real unit loads its factory sounds from disk; KLINKE has none, so bank A starts with simple
// synthesised drums (made here, at the SP-1200's rate and resolution) and B–D start empty for
// sampling.

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

const make = (seconds: number, f: (t: number, i: number) => number) =>
  Float32Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) => quantize12(f(i / RATE, i)).value,
  );

export const KIT_NAMES = ['KICK', 'SNARE', 'CL HAT', 'OP HAT', 'CLAP', 'TOM HI', 'TOM LO', 'RIM'];
/** Default output channels for the kit (§1M): drums on the filtered channels. */
export const KIT_CHANNELS = [1, 2, 3, 4, 5, 6, 6, 7];

export function kitSound(index: number): Float32Array {
  const noise = rng(index + 11);
  // One-pole high-pass for the hats
  let prev = 0;
  let hp = 0;
  const hiss = () => {
    const x = noise();
    hp = 0.82 * (hp + x - prev);
    prev = x;
    return hp;
  };
  switch (index) {
    case 0: {
      let ph = 0;
      return make(0.45, (t) => {
        ph += (2 * Math.PI * (45 + 90 * Math.exp(-t * 28))) / RATE;
        return 0.95 * Math.sin(ph) * Math.exp(-t * 7);
      });
    }
    case 1:
      return make(
        0.3,
        (t) =>
          0.5 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 22) +
          0.55 * noise() * Math.exp(-t * 14),
      );
    case 2:
      return make(0.09, (t) => 0.7 * hiss() * Math.exp(-t * 60));
    case 3:
      return make(0.6, (t) => 0.6 * hiss() * Math.exp(-t * 6));
    case 4:
      return make(0.35, (t) => {
        const burst = [0, 0.011, 0.022].some((b) => t >= b && t < b + 0.008) ? 1 : 0;
        return 0.7 * noise() * (burst ? 1 : Math.exp(-(t - 0.03) * 16) * (t > 0.03 ? 1 : 0.2));
      });
    case 5:
    case 6: {
      const f = index === 5 ? 190 : 120;
      let ph = 0;
      return make(0.5, (t) => {
        ph += (2 * Math.PI * f * (1 + 0.6 * Math.exp(-t * 20))) / RATE;
        return 0.85 * Math.sin(ph) * Math.exp(-t * 6);
      });
    }
    default:
      return make(
        0.08,
        (t) => (0.6 * Math.sin(2 * Math.PI * 1700 * t) + 0.4 * noise()) * Math.exp(-t * 45),
      );
  }
}

// ── Front panel ─────────────────────────────────────────
// The module function lists as printed on the panel, and helpers for the panel's LCD.

export interface PanelFunction {
  key: number;
  name: string;
}

/** SET-UP functions, keyed in as two digits (11–23). */
export const SETUP_FUNCTIONS: PanelFunction[] = [
  [11, 'Multi Pitch'],
  [12, 'Multi Level'],
  [13, 'Exit Multi Mode'],
  [14, 'Dynamic Buttons'],
  [15, 'Define Mix'],
  [16, 'Select Mix'],
  [17, 'Channel Assign'],
  [18, 'Decay/Tune Select'],
  [19, 'Loop/Truncate'],
  [20, 'Delete Sound'],
  [21, '1st Song/Step'],
  [22, 'MIDI Parameters'],
  [23, 'Special'],
].map(([key, name]) => ({ key: key as number, name: name as string }));

export const DISK_FUNCTIONS: PanelFunction[] = [
  [1, 'Save Sequences'],
  [2, 'Save Sounds'],
  [3, 'Load Sequences'],
  [4, 'Load Segment #'],
  [5, 'Load Sounds'],
  [6, 'Load Sounds #'],
  [7, 'Catalog Sequences'],
  [8, 'Catalog Sounds'],
  [9, 'Format/Copy Software'],
  [0, 'Load Seqs and Sounds'],
].map(([key, name]) => ({ key: key as number, name: name as string }));

export const SYNC_FUNCTIONS: PanelFunction[] = [
  [1, 'Internal'],
  [2, 'MIDI'],
  [3, 'SMPTE'],
  [4, 'Click'],
].map(([key, name]) => ({ key: key as number, name: name as string }));

export const SAMPLE_FUNCTIONS: PanelFunction[] = [
  [1, 'VU Mode'],
  [2, 'Assign Voice'],
  [3, 'Level'],
  [4, 'Threshold Set'],
  [5, 'Sample Length'],
  [6, 'Re-Sample'],
  [7, 'Arm Sampling'],
  [9, 'Force Sampling'],
].map(([key, name]) => ({ key: key as number, name: name as string }));

/** The LCD: two lines of 16 characters. */
export const LCD_COLS = 16;
export const lcdLine = (text: string) => text.slice(0, LCD_COLS).padEnd(LCD_COLS);

/**
 * SET-UP 19 coarse / fine slider pairs (§4H): the coarse slider picks one of COARSE_STEPS blocks
 * of the sound, the fine slider a position inside that block, so together they cover 0–1.
 */
export const COARSE_STEPS = 32;
export const coarseOf = (v: number) =>
  Math.min(COARSE_STEPS - 1, Math.floor(v * COARSE_STEPS)) / (COARSE_STEPS - 1);
export const fineOf = (v: number) => {
  const block = Math.min(COARSE_STEPS - 1, Math.floor(v * COARSE_STEPS));
  return Math.min(1, v * COARSE_STEPS - block);
};
/** Position from a coarse slider move, keeping the fine part. */
export const withCoarse = (v: number, coarse: number) =>
  Math.min(1, (Math.round(coarse * (COARSE_STEPS - 1)) + fineOf(v)) / COARSE_STEPS);
/** Position from a fine slider move, keeping the coarse block. */
export const withFine = (v: number, fine: number) =>
  Math.min(1, (Math.round(coarseOf(v) * (COARSE_STEPS - 1)) + fine) / COARSE_STEPS);

/** What the unit reports for the panel: the display text plus a machine line (see `spStatus`). */
export interface SpStatus {
  /** The two LCD lines from the unit (location / message, then the VU meter). */
  top: string;
  vu: string;
  phase: 'idle' | 'armed' | 'sampling';
  /** Samples in the selected location (0 = empty). */
  length: number;
  /** Largest free space in one zone, seconds. */
  free: number;
}

/** The unit's status text: `top \n vu \n phase length free`. */
export const formatStatus = (s: SpStatus) =>
  `${s.top}\n${s.vu}\n${s.phase} ${s.length} ${s.free.toFixed(2)}`;

export function parseStatus(text: string | undefined): SpStatus | null {
  if (!text) return null;
  const [top = '', vu = '', info = ''] = text.split('\n');
  const [phase, length, free] = info.split(' ');
  return {
    top,
    vu,
    phase: phase === 'armed' || phase === 'sampling' ? phase : 'idle',
    length: Number(length) || 0,
    free: Number(free) || 0,
  };
}
