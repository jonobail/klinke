// Audio takes: WAV encoding for EXPORT MIX and waveform peaks for drawing takes. Pure.

/** Joins captured chunks (one Float32Array per channel each) into one array per channel. */
export function joinChunks(chunks: Float32Array[][], channels: number): Float32Array[] {
  const length = chunks.reduce((n, c) => n + (c[0]?.length ?? 0), 0);
  return Array.from({ length: channels }, (_, ch) => {
    const out = new Float32Array(length);
    let at = 0;
    for (const c of chunks) {
      const data = c[ch] ?? c[0]; // a mono chunk fills every channel
      out.set(data, at);
      at += data.length;
    }
    return out;
  });
}

/** 16-bit PCM WAV, interleaved, clipping at full scale. */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const bytes = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(bytes);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * ch * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, n * ch * 2, true);
  let at = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(at, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      at += 2;
    }
  }
  return bytes;
}

/** Peak level (0–1, both channels) per slice, `perSecond` slices a second, for drawing a take. */
export function peaks(channels: Float32Array[], sampleRate: number, perSecond = 50): number[] {
  const n = channels[0]?.length ?? 0;
  const step = Math.max(1, Math.round(sampleRate / perSecond));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) {
    let peak = 0;
    for (const c of channels) {
      for (let j = i; j < Math.min(n, i + step); j++) peak = Math.max(peak, Math.abs(c[j]));
    }
    out.push(Math.round(Math.min(1, peak) * 1000) / 1000);
  }
  return out;
}

/** Drops leading frames (to line a take up with the beat it was recorded from). */
export const trimStart = (channels: Float32Array[], frames: number): Float32Array[] =>
  channels.map((c) => c.slice(Math.max(0, Math.min(c.length, frames))));
