'use strict';
// music-api: the few things OpenSubsonic can't do, on behalf of a Navidrome admin.
//
//   POST /api/songs/delete?u=..&t=..&s=..     body: {"id": "<song id>"}   delete the file
//   GET  /api/status?u=..&t=..&s=..           -> {total, free} bytes of the library's disk
//   POST /api/add?u=..&t=..&s=..              body: {"query": "song name"} run add_musics.sh
//   GET  /api/add/current?u=..&t=..&s=..      -> latest add job, if any
//   GET  /api/add/events?id=..&u=..&t=..&s=.. Server-Sent Events: the script's output live
//
// The caller passes the same Subsonic token-auth params it uses against /rest.
// We never see the password: we replay u/t/s to Navidrome (getUser) to prove they
// are valid and belong to an admin, and (getSong) that the song exists.
//
// The `path` in Subsonic responses is a virtual Artist/Album/Title path, NOT the
// file on disk, so the real library-relative path is read from Navidrome's own
// SQLite DB (mounted read-only) by song id.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const ND_URL = process.env.ND_URL || 'http://navidrome:4533';
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || '/music');
const ND_DB = process.env.ND_DB || '/nd/navidrome.db';
const PORT = Number(process.env.PORT || 3000);
const ADD_SCRIPT = process.env.ADD_SCRIPT || '/scripts/add_musics.sh';
const ADD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_LINES = 3000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function nd(endpoint, auth, extra = {}) {
  const q = new URLSearchParams({ u: auth.u, t: auth.t, s: auth.s, v: '1.16.1', c: 'music-api', f: 'json', ...extra });
  let res;
  try {
    res = await fetch(`${ND_URL}/rest/${endpoint}?${q}`);
  } catch {
    throw new HttpError(502, 'Navidrome unreachable');
  }
  const body = (await res.json())['subsonic-response'];
  if (body.status !== 'ok') {
    const code = body.error?.code;
    throw new HttpError(code === 40 || code === 41 ? 401 : 502, body.error?.message || 'Navidrome error');
  }
  return body;
}

// Library-relative path of a song's file, straight from Navidrome's DB.
function realPathOf(id) {
  const db = new DatabaseSync(ND_DB, { readOnly: true });
  try {
    return db.prepare('SELECT path FROM media_file WHERE id = ? AND missing = 0').get(id)?.path;
  } finally {
    db.close();
  }
}

// Resolve a Navidrome song path to a file inside MUSIC_DIR, or throw.
function resolveInMusicDir(songPath) {
  const abs = path.resolve(MUSIC_DIR, songPath);
  const rel = path.relative(MUSIC_DIR, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Path outside library');
  return abs;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new HttpError(413, 'Body too large');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function parseAuth(url) {
  const auth = { u: url.searchParams.get('u'), t: url.searchParams.get('t'), s: url.searchParams.get('s') };
  if (!auth.u || !auth.t || !auth.s) throw new HttpError(401, 'Missing credentials');
  return auth;
}

// Free / total space of the pool that holds the library (any valid user may ask).
async function status(url) {
  await nd('ping', parseAuth(url));
  const st = await fs.statfs(MUSIC_DIR);
  return { ok: true, total: st.blocks * st.bsize, free: st.bavail * st.bsize };
}

// Valid credentials AND an admin, or throw.
async function requireAdmin(auth) {
  const { user } = await nd('getUser', auth, { username: auth.u });
  if (!user.adminRole) throw new HttpError(403, 'Admin only');
}

async function deleteSong(req, url) {
  const auth = parseAuth(url);

  const { id } = await readJson(req);
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'Missing song id');

  await requireAdmin(auth);

  await nd('getSong', auth, { id });   // proves the song exists and is visible to this user
  const rel = realPathOf(id);
  if (!rel) throw new HttpError(404, 'Song not found in library');
  const file = resolveInMusicDir(rel);

  const st = await fs.lstat(file).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, 'File not found on disk');
  await fs.unlink(file);
  console.log(`deleted ${file} (song ${id}) by ${auth.u}`);

  // Let Navidrome notice the file is gone. A failed scan trigger is not fatal.
  await nd('startScan', auth).catch((e) => console.error('startScan failed:', e.message));
  return { ok: true };
}


/* ---------------- add music: run add_musics.sh, stream its output ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let job = null;   // only the latest job is kept: {id, query, status, lines, clients}

// The name ends up as an argument of yt-dlp (the script also passes it after "--").
function validateQuery(q) {
  if (typeof q !== 'string') throw new HttpError(400, 'Missing song name');
  const query = q.trim();
  if (!query) throw new HttpError(400, 'Missing song name');
  if (query.length > 200) throw new HttpError(400, 'Song name too long');
  if (/[\u0000-\u001f\u007f]/.test(query)) throw new HttpError(400, 'Invalid characters in song name');
  if (query.startsWith('-')) throw new HttpError(400, 'A song name can’t start with "-"');
  return query;
}

const sse = (event, data, id) => `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function emit(j, text, kind) {
  if (kind === 'out' && j.lines.length >= MAX_LOG_LINES) return;   // never drop our own status lines
  j.lines.push({ kind, text });
  const msg = sse('line', { kind, text }, j.lines.length - 1);
  for (const res of j.clients) res.write(msg);
}

function finish(j, ok) {
  j.status = ok ? 'done' : 'failed';
  for (const res of j.clients) { res.write(sse('end', { ok })); res.end(); }
  j.clients.clear();
}

// Make Navidrome pick up the new files, and wait until its scan is over.
async function refreshLibrary(auth) {
  await nd('startScan', auth);
  await sleep(1000);
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(1500)) {
    if (!(await nd('getScanStatus', auth)).scanStatus.scanning) return;
  }
}

function startAdd(auth, query) {
  if (job?.status === 'running') throw new HttpError(409, 'A download is already running');
  const j = job = { id: crypto.randomUUID(), query, status: 'running', lines: [], clients: new Set() };
  console.log(`add "${query}" by ${auth.u}`);

  const child = spawn('bash', [ADD_SCRIPT, query], {
    detached: true,   // own process group, so a timeout kills yt-dlp/ffmpeg too
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: '/tmp', XDG_CACHE_HOME: '/tmp/.cache', DEST_DIR: MUSIC_DIR },
  });
  const timer = setTimeout(() => {
    emit(j, 'Timed out after 10 minutes, stopping.', 'sys');
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }, ADD_TIMEOUT_MS);

  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const parts = (buf + chunk).split(/\r\n|\n|\r/);   // \r: progress bars redraw in place
      buf = parts.pop();
      for (const line of parts) emit(j, line, 'out');
    });
    stream.on('end', () => { if (buf) emit(j, buf, 'out'); });
  }

  child.on('error', (e) => { clearTimeout(timer); emit(j, `Could not start the script: ${e.message}`, 'sys'); finish(j, false); });
  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    if (j.status !== 'running') return;
    if (code !== 0) {
      emit(j, signal ? `Stopped (${signal}).` : `The script failed (exit code ${code}).`, 'sys');
      return finish(j, false);
    }
    emit(j, 'Refreshing the library…', 'sys');
    try {
      await refreshLibrary(auth);
      emit(j, 'Library updated.', 'sys');
    } catch (e) {
      emit(j, `Songs were added, but refreshing the library failed: ${e.message}`, 'sys');
    }
    finish(j, true);
  });
  return j;
}

async function addRoutes(req, res, url, send) {
  const auth = parseAuth(url);
  await requireAdmin(auth);

  if (req.method === 'POST' && url.pathname === '/api/add') {
    const { query } = await readJson(req);
    return send(200, { ok: true, id: startAdd(auth, validateQuery(query)).id });
  }
  if (req.method === 'GET' && url.pathname === '/api/add/current') {
    return send(200, { ok: true, job: job && { id: job.id, query: job.query, status: job.status } });
  }
  if (req.method === 'GET' && url.pathname === '/api/add/events') {
    const j = job;
    if (!j || j.id !== url.searchParams.get('id')) throw new HttpError(404, 'Unknown job');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const last = Number.parseInt(req.headers['last-event-id'], 10);   // set by EventSource when it reconnects
    const from = Number.isInteger(last) ? last + 1 : 0;
    j.lines.slice(from).forEach((l, i) => res.write(sse('line', l, from + i)));
    if (j.status !== 'running') { res.write(sse('end', { ok: j.status === 'done' })); return res.end(); }
    j.clients.add(res);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);   // keeps proxies from idling out
    res.on('close', () => { clearInterval(beat); j.clients.delete(res); });
    return undefined;
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await status(url));
    if (req.method === 'POST' && url.pathname === '/api/songs/delete') return send(200, await deleteSong(req, url));
    if (url.pathname.startsWith('/api/add')) return await addRoutes(req, res, url, send);
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(e.status || 500, { ok: false, error: e.status ? e.message : 'Internal error' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`music-api on :${PORT}, library ${MUSIC_DIR}`));
module.exports = { resolveInMusicDir, validateQuery };
