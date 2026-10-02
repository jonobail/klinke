// Sound maths shared by the audio engine: how 0–1 knob values map to real units, note numbers,
// and the computer-keyboard layout. No Web Audio here, so it all runs under node --test.

/** Exponential 0–1 → [min, max], for frequencies and times that the ear hears logarithmically. */
export const expMap = (v: number, min: number, max: number) => min * Math.pow(max / min, v);

/** Fader position → gain. Three-quarter travel is unity; the top gives about +5 dB of headroom. */
export const faderGain = (v: number) => Math.pow(v / 0.75, 2);

/** Equal-power dry / wet sends for a MIX knob. */
export const mixSends = (mix: number) => ({
  dry: Math.cos((mix * Math.PI) / 2),
  wet: Math.sin((mix * Math.PI) / 2),
});

/** StereoPanner position from a centre-detented 0–1 knob. */
export const panFor = (v: number) => v * 2 - 1;

export const noteFreq = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (note: number) => `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`;

/**
 * Soft-clipping transfer curve for the overdrive. DRIVE sweeps from barely-warm to fuzz; the
 * curve is normalised so a full-scale input still peaks at ±1.
 */
export function driveCurve(drive: number, size = 2048): Float32Array<ArrayBuffer> {
  const k = 1 + drive * 60;
  const norm = Math.tanh(k);
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** RMS of a block of samples → a 0–1 meter reading over a 60 dB range. */
export function meterLevel(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60));
}

/**
 * Computer keyboard → semitones above the base C, piano-style: the home row is the white keys,
 * the row above the black keys. Uses `KeyboardEvent.code`, so it works on any layout.
 */
export const KEY_NOTES: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
  Quote: 17,
};

/** The base C moves in octaves between C1 and C6. */
export const BASE_MIN = 24;
export const BASE_MAX = 84;
export const shiftBase = (base: number, octaves: number) =>
  Math.min(BASE_MAX, Math.max(BASE_MIN, base + octaves * 12));

/** One MIDI message → a note event, or null for anything else. */
export type MidiEvent =
  | { type: 'on' | 'off'; note: number; velocity: number }
  /** Pitch bend, -1…+1. */
  | { type: 'bend'; value: number }
  /** Control change, value 0…1. */
  | { type: 'cc'; controller: number; value: number };

/** One MIDI message → a note, pitch-bend or control-change event, or null for anything else. */
export function parseMidi(data: ArrayLike<number>): MidiEvent | null {
  const status = data[0] & 0xf0;
  const d1 = data[1];
  const d2 = data[2] ?? 0;
  if (status === 0x90 && d2 > 0) return { type: 'on', note: d1, velocity: d2 };
  if (status === 0x80 || (status === 0x90 && d2 === 0))
    return { type: 'off', note: d1, velocity: 0 };
  if (status === 0xe0) return { type: 'bend', value: Math.max(-1, ((d2 << 7) | d1) / 8192 - 1) };
  if (status === 0xb0) return { type: 'cc', controller: d1, value: d2 / 127 };
  return null;
}

/** Seeded noise impulse response with a decaying tail, one array per channel. */
export function reverbImpulse(
  seconds: number,
  rate: number,
  channels = 2,
  seed = 1,
): Float32Array<ArrayBuffer>[] {
  const length = Math.max(1, Math.floor(seconds * rate));
  let s = seed >>> 0 || 1;
  const rand = () => {
    // xorshift32: deterministic so a patch always sounds the same
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
  return Array.from({ length: channels }, () => {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = rand() * Math.pow(1 - i / length, 3);
    return data;
  });
}
