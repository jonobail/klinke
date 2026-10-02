// KLINKE media helper: lets the VIDEO DECK play a YouTube video's audio through Web Audio.
//
// A page can't tap the sound of an embedded YouTube player (it's another site's frame), so this
// helper looks up the video's audio-only stream with yt-dlp and relays it, same-origin, to the
// deck's <audio> element. It relays bytes as the browser asks for them (HTTP ranges, so seeking
// works) and writes nothing to disk: no audio is kept anywhere but the browser's media buffer.
//
//   GET /api/health            { ok, tools }
//   GET /api/yt/info?v=<id>    { id, title, duration }
//   GET /api/yt/audio?v=<id>   the audio stream (206 partial responses, ≤ 10 MB each)
//
// Run with `npm run server` (127.0.0.1:3800); the dev server proxies /api here (proxy.conf.json).
// Needs yt-dlp (and deno, which yt-dlp uses for YouTube's player code): `npm run setup:tools`.
// No npm dependencies.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { VIDEO_ID_RE, upstreamRange } from './lib/range.mjs';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3800);
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin');
/** $VAR, else server/bin, else PATH. */
const tool = (env, name) =>
  process.env[env] ?? (existsSync(path.join(bin, name)) ? path.join(bin, name) : name);
const YTDLP = tool('YTDLP', 'yt-dlp');
const DENO = tool('DENO', 'deno');
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio';
const HOUR = 3_600_000;

const baseArgs = ['--ignore-config', '--no-playlist', '--no-warnings'];
if (path.isAbsolute(DENO)) baseArgs.push('--js-runtimes', `deno:${DENO}`);

/** Looked-up streams: stream URLs stay valid for hours; cache them for one. */
const streams = new Map(); // id -> { exp, promise }

function resolve(id) {
  const hit = streams.get(id);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = new Promise((ok, fail) => {
    const args = [
      ...baseArgs,
      '-f',
      AUDIO_FORMAT,
      '--print',
      '%(title)s\t%(duration)s\t%(live_status)s\t%(ext)s',
      '--print',
      'urls',
      '--',
      `https://www.youtube.com/watch?v=${id}`,
    ];
    execFile(YTDLP, args, { timeout: 45_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const why =
          err.code === 'ENOENT'
            ? 'yt-dlp not found: run "npm run setup:tools"'
            : String(stderr).trim().split('\n').pop();
        return fail(Object.assign(new Error(why || err.message), { status: 502 }));
      }
      const [meta = '', url = ''] = stdout.trim().split('\n');
      const [title, duration, live, ext] = meta.split('\t');
      if (live === 'is_live' || live === 'is_upcoming') {
        return fail(Object.assign(new Error('Live streams can’t be played'), { status: 422 }));
      }
      if (!/^https:\/\//.test(url))
        return fail(Object.assign(new Error('No audio stream found'), { status: 502 }));
      ok({
        id,
        title: title || id,
        duration: Number(duration) || 0,
        url,
        type: ext === 'webm' ? 'audio/webm' : 'audio/mp4',
      });
    });
  });
  streams.set(id, { exp: Date.now() + HOUR, promise });
  promise.catch(() => streams.delete(id));
  if (streams.size > 200) streams.delete(streams.keys().next().value);
  return promise;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function relay(req, res, id, retry = true) {
  const range = upstreamRange(req.headers.range);
  if (!range) return json(res, 416, { error: 'Unsupported range' });
  const stream = await resolve(id);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const up = await fetch(stream.url, {
    headers: { range: `bytes=${range.start}-${range.end}` },
    signal: abort.signal,
  });
  if ((up.status === 403 || up.status === 410) && retry) {
    streams.delete(id); // the signed URL expired: look it up again once
    return relay(req, res, id, false);
  }
  if (up.status === 416) return json(res, 416, { error: 'Range not satisfiable' });
  if (!up.ok || !up.body) return json(res, 502, { error: `YouTube answered ${up.status}` });
  const headers = {
    'content-type': stream.type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  for (const h of ['content-length', 'content-range'])
    if (up.headers.get(h)) headers[h] = up.headers.get(h);
  res.writeHead(up.status === 206 ? 206 : 200, headers);
  Readable.fromWeb(up.body)
    .on('error', () => res.destroy())
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, tools: existsSync(YTDLP) || !path.isAbsolute(YTDLP) });
    }
    const id = url.searchParams.get('v') ?? '';
    if (url.pathname.startsWith('/api/yt/') && !VIDEO_ID_RE.test(id)) {
      return json(res, 400, { error: 'Not a YouTube video ID' });
    }
    if (url.pathname === '/api/yt/info') {
      const { title, duration } = await resolve(id);
      return json(res, 200, { id, title, duration });
    }
    if (url.pathname === '/api/yt/audio') return await relay(req, res, id);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err?.name === 'AbortError') return; // the browser moved on (seek / stop)
    if (!res.headersSent) json(res, err?.status ?? 500, { error: err?.message ?? 'Failed' });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => console.log(`KLINKE media helper on http://${HOST}:${PORT}`));
