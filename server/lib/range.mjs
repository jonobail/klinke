// HTTP Range helpers for the audio relay. Pure functions, tested in tests/server-range.test.ts.

/** YouTube serves large unbounded ranges slowly, so each relayed request covers at most this. */
export const CHUNK = 10 * 1024 * 1024;

/**
 * The browser's `Range` header → the byte range to ask YouTube for: from the requested start, up
 * to the requested end but never more than CHUNK bytes. The browser receives a 206 for that
 * piece and asks for the next one as it plays. Returns null for a malformed or multi-part range.
 */
export function upstreamRange(header) {
  if (!header) return { start: 0, end: CHUNK - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return null; // suffix ranges ("last N bytes") aren't needed for playback
  const start = Number(m[1]);
  const wanted = m[2] === '' ? Infinity : Number(m[2]);
  if (wanted < start) return null;
  return { start, end: Math.min(wanted, start + CHUNK - 1) };
}

/** A YouTube video ID: the only user-supplied value that ever reaches yt-dlp. */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
