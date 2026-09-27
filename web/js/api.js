// OpenSubsonic client (https://opensubsonic.netlify.app/docs/). Token auth: the
// password is only used at login to derive t = md5(password + salt); we keep
// {u, s, t} and never store the password itself.
import { md5 } from './md5.js';

const KEY = 'pm.auth';
const API_VERSION = '1.16.1';
const CLIENT = 'music';
const PAGE = 500;

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let auth = null;

export function loadAuth() {
  try {
    auth = JSON.parse(localStorage.getItem(KEY));
  } catch {
    auth = null;
  }
  return auth;
}

export function clearAuth() {
  auth = null;
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export async function login(username, password) {
  const salt = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  auth = { u: username, s: salt, t: md5(password + salt) };
  try {
    await call('ping');
  } catch (e) {
    auth = null;
    throw e;
  }
  try { localStorage.setItem(KEY, JSON.stringify(auth)); } catch { /* storage unavailable */ }
  return auth.u;
}

// params: object, or array of [key, value] pairs when a key repeats.
function query(params = {}) {
  const q = new URLSearchParams({ u: auth.u, t: auth.t, s: auth.s, v: API_VERSION, c: CLIENT, f: 'json' });
  for (const [k, v] of Array.isArray(params) ? params : Object.entries(params)) q.append(k, v);
  return q;
}

async function call(endpoint, params) {
  let res;
  try {
    res = await fetch(`/rest/${endpoint}?${query(params)}`);
  } catch {
    throw new ApiError(0, 'Server unreachable');
  }
  const body = (await res.json())['subsonic-response'];
  if (body.status !== 'ok') throw new ApiError(body.error?.code, body.error?.message);
  return body;
}

export const streamUrl = (id) => `/rest/stream?${query({ id })}`;
export const coverUrl = (id, size = 96) => `/rest/getCoverArt?${query({ id, size })}`;

// search3 with an empty query returns the whole library, paged.
export async function allSongs() {
  const songs = [];
  for (let offset = 0; ; offset += PAGE) {
    const { searchResult3 } = await call('search3', { query: '', artistCount: 0, albumCount: 0, songCount: PAGE, songOffset: offset });
    const page = searchResult3.song || [];
    songs.push(...page);
    if (page.length < PAGE) return songs;
  }
}

export async function getPlaylists() {
  return (await call('getPlaylists')).playlists.playlist || [];
}

export async function getPlaylist(id) {
  return (await call('getPlaylist', { id })).playlist;
}

export async function createPlaylist(name, songIds = []) {
  return (await call('createPlaylist', [['name', name], ...songIds.map((id) => ['songId', id])])).playlist;
}

export async function ping() {
  const t0 = performance.now();
  const body = await call('ping');
  return { version: (body.serverVersion || '').split(' ')[0], ms: Math.round(performance.now() - t0) };
}

export async function scanStatus() {
  return (await call('getScanStatus')).scanStatus;
}

// Disk usage of the library, from music-api (not part of OpenSubsonic).
export async function storage() {
  const { u, t, s } = auth;
  const res = await fetch(`/api/status?${new URLSearchParams({ u, t, s })}`);
  if (!res.ok) throw new ApiError(res.status, 'Storage status unavailable');
  return res.json();
}

// Both take one value or an array (the parameter is simply repeated).
export const addToPlaylist = (playlistId, songIds) =>
  call('updatePlaylist', [['playlistId', playlistId], ...[].concat(songIds).map((id) => ['songIdToAdd', id])]);
export const removeFromPlaylist = (playlistId, indexes) =>
  call('updatePlaylist', [['playlistId', playlistId], ...[].concat(indexes).map((i) => ['songIndexToRemove', i])]);
export const deletePlaylist = (id) => call('deletePlaylist', { id });

// Not part of OpenSubsonic: handled by music-api (see api/server.js).
export async function deleteSong(id) {
  const { u, t, s } = auth;
  const res = await fetch(`/api/songs/delete?${new URLSearchParams({ u, t, s })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || 'Delete failed');
}

/* ---- add music (music-api runs add_musics.sh and streams its output) ---- */
function apiUrl(path, extra = {}) {
  const { u, t, s } = auth;
  return `${path}?${new URLSearchParams({ u, t, s, ...extra })}`;
}

async function apiJson(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || 'Request failed');
  return body;
}

export const startAdd = (query) => apiJson(apiUrl('/api/add'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
export const currentAdd = async () => (await apiJson(apiUrl('/api/add/current'))).job;
export const addEvents = (id) => new EventSource(apiUrl('/api/add/events', { id }));
