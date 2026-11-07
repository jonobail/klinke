// The `.klinke` project bundle: one file holding a project's patch, song and recorded audio, for
// moving a project between browsers. Pure, tested in tests/bundle.test.ts.
//
// Layout (all numbers little-endian):
//   "KLINKE" 0x00 0x01   magic and format version (8 bytes)
//   u32                  length of the JSON header in bytes
//   JSON (UTF-8)         { project: <anything JSON>, audio: [{ id, sampleRate, frames, channels }] }
//   PCM                  for each audio entry in order, each channel's frames as float32

export const BUNDLE_EXT = '.klinke';
const MAGIC = [0x4b, 0x4c, 0x49, 0x4e, 0x4b, 0x45, 0x00, 0x01]; // "KLINKE" \0 \1
const HEAD = MAGIC.length + 4;
/** Sanity limits, so a damaged file can't ask for absurd allocations. */
const MAX_CHANNELS = 8;
const MAX_RATE = 384000;

export interface BundleAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export interface Bundle<P = unknown> {
  /** The project itself: patch, song and its name, as JSON. */
  project: P;
  /** Recorded audio by take id. */
  audio: Map<string, BundleAudio>;
}

interface AudioEntry {
  id: string;
  sampleRate: number;
  frames: number;
  channels: number;
}

export function encodeBundle(bundle: Bundle): Uint8Array<ArrayBuffer> {
  const entries: AudioEntry[] = [...bundle.audio].map(([id, a]) => ({
    id,
    sampleRate: a.sampleRate,
    frames: a.channels[0]?.length ?? 0,
    channels: a.channels.length,
  }));
  const json = new TextEncoder().encode(
    JSON.stringify({ project: bundle.project, audio: entries }),
  );
  const pcmBytes = entries.reduce((n, e) => n + e.frames * e.channels * 4, 0);
  const out = new Uint8Array(HEAD + json.length + pcmBytes);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(MAGIC.length, json.length, true);
  out.set(json, HEAD);
  let at = HEAD + json.length;
  for (const [, a] of bundle.audio) {
    const frames = a.channels[0]?.length ?? 0;
    for (const ch of a.channels) {
      for (let i = 0; i < frames; i++, at += 4) view.setFloat32(at, ch[i] ?? 0, true);
    }
  }
  return out;
}

/** Reads a bundle; undefined when the bytes aren't one (wrong magic, truncated, bad header). */
export function decodeBundle(bytes: Uint8Array): Bundle | undefined {
  if (bytes.length < HEAD || MAGIC.some((b, i) => bytes[i] !== b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(MAGIC.length, true);
  if (HEAD + jsonLength > bytes.length) return undefined;
  let head: { project?: unknown; audio?: unknown };
  try {
    head = JSON.parse(new TextDecoder().decode(bytes.subarray(HEAD, HEAD + jsonLength)));
  } catch {
    return undefined;
  }
  if (!head || typeof head !== 'object' || !('project' in head) || !Array.isArray(head.audio))
    return undefined;
  const audio = new Map<string, BundleAudio>();
  let at = HEAD + jsonLength;
  for (const e of head.audio as AudioEntry[]) {
    const ok =
      e &&
      typeof e.id === 'string' &&
      Number.isInteger(e.frames) &&
      e.frames >= 0 &&
      Number.isInteger(e.channels) &&
      e.channels >= 1 &&
      e.channels <= MAX_CHANNELS &&
      Number.isFinite(e.sampleRate) &&
      e.sampleRate > 0 &&
      e.sampleRate <= MAX_RATE;
    if (!ok || at + e.frames * e.channels * 4 > bytes.length) return undefined;
    const channels: Float32Array[] = [];
    for (let c = 0; c < e.channels; c++) {
      const ch = new Float32Array(e.frames);
      for (let i = 0; i < e.frames; i++, at += 4) ch[i] = view.getFloat32(at, true);
      channels.push(ch);
    }
    audio.set(e.id, { sampleRate: e.sampleRate, channels });
  }
  return { project: head.project, audio };
}

/** A file name for a project: its name, kept to safe characters. */
export function bundleName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${safe || 'klinke-project'}${BUNDLE_EXT}`;
}
