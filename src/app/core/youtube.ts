// YouTube links → video IDs, for the VIDEO DECK. Pure, tested in tests/youtube.test.ts.

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video ID from anything people paste: watch?v= links (with extra parameters),
 * youtu.be short links, /shorts/, /embed/, /live/, music.youtube.com, or a bare ID. Null if none.
 */
export function videoId(input: string): string | null {
  const text = input.trim();
  if (ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
    if (!id && m) id = m[1];
  }
  return id && ID.test(id) ? id : null;
}

/** A start time from the link (`t=90`, `t=1m30s`, `start=90`), in seconds, or 0. */
export function startTime(input: string): number {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return 0;
  }
  const t = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '';
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m && t ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** 83.4 → "1:23". */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
