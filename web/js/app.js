import * as api from './api.js';
import { icon, hydrateIcons } from './icons.js';

const $ = (id) => document.getElementById(id);

// Tiny DOM builder. Text always goes through textContent, so song titles etc. can't inject markup.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
}

const state = {
  user: null,
  songs: [],            // whole library
  playlists: [],
  view: { type: 'all' },// {type:'all'} | {type:'playlist', id}
  shown: [],            // songs in the current view, in source order
  sort: { key: 'title', dir: 1 },
  queue: [],
  index: -1,
  history: [],          // queue indexes played before the current one, so Previous goes back (also when shuffling)
  shuffle: false,
  repeat: 'off',        // off | all | one
  sel: null,            // multi-select: Set of indexes into `shown`, or null when not selecting
};
const audio = $('audio');
hydrateIcons();

/* ---------------- helpers ---------------- */
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtLong = (sec) => {
  const hrs = Math.floor(sec / 3600), min = Math.round((sec % 3600) / 60);
  return hrs ? `${hrs}h ${min}m` : `${min}m`;
};
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const pref = {
  get: (k, d) => { try { return localStorage.getItem(`pm.${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`pm.${k}`, v); } catch { /* storage unavailable */ } },
};

function toast(text, err = false) {
  const el = h('div', { class: `toast${err ? ' err' : ''}` }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.code === 40 || e.code === 41 || e.code === 401) return logout();
    toast(e.message || 'Something went wrong', true);
  }
}

/* ---------------- session ---------------- */
function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  document.querySelector('#login-form [name=username]').focus();
}

function logout() {
  audio.pause();
  api.clearAuth();
  location.reload();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('login-error').textContent = '';
  try {
    state.user = await api.login(f.get('username').trim(), f.get('password'));
    e.target.reset();
    await start();
  } catch (err) {
    $('login-error').textContent = err.code === 40 ? 'Wrong username or password.' : err.message;
  }
});
$('logout').addEventListener('click', logout);

async function start() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('whoami').textContent = state.user;
  $('list').replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  refreshStatus();
  await guard(async () => {
    [state.songs, state.playlists] = await Promise.all([api.allSongs(), api.getPlaylists()]);
    $('all-count').textContent = state.songs.length;
    await openView({ type: 'all' });
    restoreSession();
    refreshStatus();
    resumeAdd();
  });
}

/* ---------------- side nav ---------------- */
// Stable hue per playlist so cover-less playlists still get their own colour.
const hue = (name) => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

function renderSide() {
  $('nav-all').classList.toggle('active', state.view.type === 'all');
  $('playlists').replaceChildren(...state.playlists.map((p) => {
    const cover = p.coverArt
      ? h('img', { class: 'pl-cover', src: api.coverUrl(p.coverArt, 96), loading: 'lazy', alt: '' })
      : h('span', { class: 'pl-cover pl-tile', style: `--h:${hue(p.name)}` }, icon('music'));
    return h('button', {
      class: `pl-item${state.view.type === 'playlist' && state.view.id === p.id ? ' active' : ''}`,
      onclick: () => guard(() => openView({ type: 'playlist', id: p.id })),
    }, cover,
    h('span', { class: 'pl-text' },
      h('span', { class: 'pl-name' }, p.name),
      h('span', { class: 'pl-meta' }, `${plural(p.songCount, 'song')} · ${fmtLong(p.duration)}`)));
  }));
}

$('nav-all').addEventListener('click', () => guard(() => openView({ type: 'all' })));
$('menu').addEventListener('click', () => $('app').classList.add('nav-open'));
$('scrim').addEventListener('click', () => $('app').classList.remove('nav-open'));

$('new-playlist').addEventListener('click', async () => {
  const name = await askName();
  if (name) await guard(async () => { await api.createPlaylist(name); await refreshPlaylists(); toast(`Playlist “${name}” created`); });
});

async function refreshPlaylists() {
  state.playlists = await api.getPlaylists();
  renderSide();
}

/* ---------------- server status ---------------- */
async function refreshStatus() {
  const pill = $('st-state');
  try {
    const [info, scan, disk] = await Promise.all([api.ping(), api.scanStatus(), api.storage().catch(() => null)]);
    pill.textContent = scan.scanning ? 'Scanning' : 'Online';
    pill.className = `pill ${scan.scanning ? 'busy' : 'ok'}`;
    $('st-version').textContent = info.version || '–';
    $('st-ping').textContent = `${info.ms} ms`;
    $('st-tracks').textContent = state.songs.length ? plural(state.songs.length, 'song') : '–';
    $('st-scan').textContent = scan.scanning ? `${scan.count} files…` : scan.lastScan ? timeAgo(scan.lastScan) : 'never';
    if (disk) {
      const used = 1 - disk.free / disk.total;
      $('st-bar').style.width = `${Math.round(used * 100)}%`;
      $('st-bar').className = used > 0.9 ? 'hot' : '';
      $('st-storage').textContent = `${fmtBytes(disk.free)} free of ${fmtBytes(disk.total)}`;
    } else {
      $('st-bar').style.width = '0';
      $('st-storage').textContent = 'Storage info unavailable';
    }
  } catch (e) {
    if (e.code === 40 || e.code === 41) return logout();
    pill.textContent = 'Offline';
    pill.className = 'pill down';
    for (const id of ['st-version', 'st-ping', 'st-scan']) $(id).textContent = '–';
  }
}
setInterval(() => { if (!document.hidden && !$('app').hidden) refreshStatus(); }, 15000);

/* ---------------- sorting + search ---------------- */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const SORTS = {
  order:    { label: 'Playlist order', cmp: () => 0 },
  title:    { label: 'Title', cmp: (a, b) => collator.compare(a.title, b.title) },
  artist:   { label: 'Artist', cmp: (a, b) => collator.compare(a.artist, b.artist), missing: (s) => !s.artist },
  album:    { label: 'Album', cmp: (a, b) => collator.compare(a.album, b.album), missing: (s) => !s.album },
  duration: { label: 'Duration', cmp: (a, b) => (a.duration || 0) - (b.duration || 0) },
  added:    { label: 'Date added', cmp: (a, b) => (a.created || '').localeCompare(b.created || '') },
  year:     { label: 'Year', cmp: (a, b) => a.year - b.year, missing: (s) => !s.year },
};

function loadSort() {
  const kind = state.view.type;
  const [key, dir] = pref.get(`sort.${kind}`, kind === 'playlist' ? 'order:1' : 'title:1').split(':');
  state.sort = { key: SORTS[key] && (key !== 'order' || kind === 'playlist') ? key : 'title', dir: dir === '-1' ? -1 : 1 };
  const keys = Object.keys(SORTS).filter((k) => k !== 'order' || kind === 'playlist');
  $('sort').replaceChildren(...keys.map((k) => h('option', { value: k }, SORTS[k].label)));
  syncSortControls();
}

function syncSortControls() {
  $('sort').value = state.sort.key;
  const btn = $('sort-dir');
  btn.replaceChildren(icon(state.sort.dir === 1 ? 'up' : 'down'));
  btn.title = state.sort.dir === 1 ? 'Ascending' : 'Descending';
  btn.setAttribute('aria-label', `Sort direction: ${btn.title.toLowerCase()}`);
}

function saveSort() {
  pref.set(`sort.${state.view.type}`, `${state.sort.key}:${state.sort.dir}`);
  syncSortControls();
  renderList();
}
$('sort').addEventListener('change', (e) => {
  state.sort = { key: e.target.value, dir: e.target.value === 'added' ? -1 : 1 };   // newest first by default
  saveSort();
});
$('sort-dir').addEventListener('click', () => { state.sort.dir *= -1; saveSort(); });

// Lowercase, no accents, no punctuation: "Beyoncé" matches "beyonce", "jay-z" matches "jay z".
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
const haystacks = new WeakMap();
const hayOf = (s) => {
  let v = haystacks.get(s);
  if (v === undefined) haystacks.set(s, v = norm(`${s.title} ${s.artist || ''} ${s.album || ''}`));
  return v;
};

// Indexes into state.shown for what is on screen: filtered by the search box, then sorted.
// (Indexes, not songs, because removing from a playlist needs the position in the playlist.)
function visibleIndexes() {
  const tokens = norm($('filter').value).split(/\s+/).filter(Boolean);
  let idx = state.shown.map((_, i) => i);
  if (tokens.length) idx = idx.filter((i) => { const hay = hayOf(state.shown[i]); return tokens.every((t) => hay.includes(t)); });
  const { key, dir } = state.sort;
  return idx.sort((i, j) => {
    // Navidrome keeps no per-entry date in a playlist, only the position, and new songs are
    // appended, so there "date added" is the position (song.created is when the file was scanned).
    if (key === 'order' || (key === 'added' && state.view.type === 'playlist')) return dir * (i - j);
    const a = state.shown[i], b = state.shown[j];
    const { missing } = SORTS[key];
    if (missing && missing(a) !== missing(b)) return missing(a) ? 1 : -1;   // blanks always last
    return dir * SORTS[key].cmp(a, b) || collator.compare(a.title, b.title) || i - j;
  });
}
const visibleSongs = () => visibleIndexes().map((i) => state.shown[i]);

let searchTimer;
$('filter').addEventListener('input', () => {
  $('filter-clear').hidden = !$('filter').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 80);
});
function clearSearch() {
  $('filter').value = '';
  $('filter-clear').hidden = true;
  renderList();
}
$('filter-clear').addEventListener('click', () => { clearSearch(); $('filter').focus(); });
$('filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if ($('filter').value) clearSearch(); else $('filter').blur(); }
});

/* ---------------- main list ---------------- */
async function openView(view) {
  state.view = view;
  $('app').classList.remove('nav-open');
  $('filter').value = '';
  $('filter-clear').hidden = true;
  state.sel = null;
  syncSelecting();
  const isPlaylist = view.type === 'playlist';
  $('app').classList.toggle('is-playlist', isPlaylist);
  $('hero').hidden = !isPlaylist;
  if (!isPlaylist) {
    state.shown = state.songs;
    $('title').textContent = 'All songs';
  } else {
    const pl = await api.getPlaylist(view.id);
    state.shown = pl.entry || [];
    $('title').textContent = pl.name;
    renderHero(pl);
  }
  loadSort();
  renderSide();
  renderList();
  $('scroller').scrollTop = 0;
}

/* ---------------- add music ---------------- */
// music-api runs add_musics.sh and streams its output (Server-Sent Events). The job
// lives on the server, so closing the dialog or reloading the page doesn't stop it.
const addDlg = $('dlg-add');
const addLog = $('add-log');
let addSource = null;

function setAddState(kind, label) {
  $('add-state').className = `pill ${kind}`;
  $('add-state').textContent = label;
  const running = kind === 'busy';
  $('add-dot').hidden = !running;
  $('add-submit').disabled = running;
  $('add-input').disabled = running;
}

function logLine(text, kind) {
  const cls = kind === 'sys' ? 'sys'
    : /^ERROR/.test(text) ? 'err'
    : /^WARNING/.test(text) ? 'warn'
    : /^(Moved successfully|Done!)/.test(text) ? 'ok'
    : /^(-{5,}|\[\d+\/\d+\])/.test(text) ? 'head' : 'out';
  const progress = /^\[download\]\s+\d+(\.\d+)?%/.test(text);
  const last = addLog.lastElementChild;
  const stick = addLog.scrollTop + addLog.clientHeight >= addLog.scrollHeight - 30;
  if (progress && last?.classList.contains('progress')) {
    last.textContent = text;                       // progress bars redraw one line, not hundreds
  } else {
    addLog.append(h('div', { class: `term-line ${cls}${progress ? ' progress' : ''}` }, text || '\u00a0'));
    while (addLog.childElementCount > 1500) addLog.firstElementChild.remove();
  }
  if (stick) addLog.scrollTop = addLog.scrollHeight;
}

// Follow a job's output. `live` = it was running when we attached, so refresh the library when it ends.
function followJob(job, live) {
  addSource?.close();
  addLog.replaceChildren();
  $('add-query').textContent = job.query || '';
  setAddState(live ? 'busy' : 'idle', live ? 'Running' : 'Loading');
  const es = addSource = api.addEvents(job.id);
  es.addEventListener('line', (e) => { const l = JSON.parse(e.data); logLine(l.text, l.kind); });
  es.addEventListener('end', async (e) => {
    es.close();
    addSource = null;
    const { ok } = JSON.parse(e.data);
    setAddState(ok ? 'ok' : 'down', ok ? 'Done' : 'Failed');
    if (live) {
      if (ok) await guard(reloadLibrary);
      toast(ok ? 'Music added' : 'Adding music failed', !ok);
    }
  });
  es.addEventListener('error', () => {
    if (es.readyState !== EventSource.CLOSED) return;   // still reconnecting
    addSource = null;
    setAddState('down', 'Disconnected');
    logLine('Lost the connection to the server.', 'sys');
  });
}

async function reloadLibrary() {
  state.songs = await api.allSongs();
  $('all-count').textContent = state.songs.length;
  if (state.view.type === 'all') { state.shown = state.songs; if (state.sel) state.sel = new Set(); renderList(); }
  refreshStatus();
}

// After a page load: pick up a download that is still running.
async function resumeAdd() {
  const job = await api.currentAdd().catch(() => null);
  if (job?.status === 'running') followJob(job, true);
}

// Back to an empty terminal (the output of a finished attempt is not kept around).
function resetAdd() {
  addLog.replaceChildren(h('div', { class: 'term-line sys' }, 'Type a song name above and press Add. The script\u2019s output shows up here.'));
  $('add-query').textContent = '';
  setAddState('idle', 'Idle');
}

// Opening the dialog shows a download that is still running; otherwise a clean screen.
async function openAdd() {
  addDlg.showModal();
  if (!addSource) {
    resetAdd();
    const job = await api.currentAdd().catch(() => null);
    if (job?.status === 'running') followJob(job, true);
  }
  if (!$('add-input').disabled) $('add-input').focus();
}

$('add-open').addEventListener('click', openAdd);
$('add-close').addEventListener('click', () => addDlg.close());
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $('add-input').value.trim();
  if (!query) return;
  await guard(async () => {
    try {
      const { id } = await api.startAdd(query);
      $('add-input').value = '';
      followJob({ id, query }, true);
    } catch (err) {
      if (err.code !== 409) throw err;
      toast('A download is already running', true);
      const job = await api.currentAdd();
      if (job) followJob(job, true);
    }
  });
});

/* ---------------- playlist header ---------------- */
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// Navidrome's own auto-import note is noise, only show comments a person wrote.
const isAutoNote = (c) => /^auto-imported/i.test(c || '');

function renderHero(pl) {
  const songs = pl.entry || [];
  const artists = new Map();
  for (const s of songs) for (const a of (s.artist || '').split('/').map((x) => x.trim()).filter(Boolean)) artists.set(a, (artists.get(a) || 0) + 1);
  const albums = new Set(songs.map((s) => s.album).filter(Boolean));
  const top = [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name);

  const cover = $('hero-cover');
  if (pl.coverArt) {
    const url = api.coverUrl(pl.coverArt, 400);
    cover.replaceChildren(h('img', { src: url, alt: '' }));
    $('hero').style.setProperty('--cover', `url("${url}")`);
  } else {
    cover.replaceChildren(h('span', { class: 'pl-tile hero-tile', style: `--h:${hue(pl.name)}` }, icon('music')));
    $('hero').style.removeProperty('--cover');
  }

  $('hero-name').textContent = pl.name;
  const note = isAutoNote(pl.comment) ? '' : pl.comment;
  $('hero-desc').textContent = note || '';
  $('hero-desc').hidden = !note;
  $('hero-artists').textContent = top.length
    ? `${top.join(', ')}${artists.size > top.length ? ` and ${artists.size - top.length} more` : ''}`
    : '';

  const stat = (value, label) => h('div', { class: 'stat' }, h('b', {}, String(value)), h('span', {}, label));
  $('hero-stats').replaceChildren(
    stat(songs.length, songs.length === 1 ? 'song' : 'songs'),
    stat(fmtLong(pl.duration || songs.reduce((t, s) => t + (s.duration || 0), 0)), 'total time'),
    stat(artists.size, artists.size === 1 ? 'artist' : 'artists'),
    stat(albums.size, albums.size === 1 ? 'album' : 'albums'));

  $('hero-dates').textContent = [
    pl.created && `Created ${fmtDate(pl.created)}`,
    pl.changed && `Updated ${fmtDate(pl.changed)}`,
    pl.owner && `by ${pl.owner}`,
  ].filter(Boolean).join(' · ');
}

$('hero-play').addEventListener('click', () => { const l = visibleSongs(); if (l.length) play(l, 0); });
$('hero-shuffle').addEventListener('click', () => {
  const l = visibleSongs();
  if (!l.length) return;
  state.shuffle = true;
  $('shuffle').setAttribute('aria-pressed', 'true');
  play(l, Math.floor(Math.random() * l.length));
});

function renderList() {
  const idx = visibleIndexes();
  const songs = idx.map((i) => state.shown[i]);
  const total = state.shown.length;
  $('subtitle').textContent = songs.length === total ? plural(total, 'song') : `${songs.length} of ${plural(total, 'song')}`;
  $('empty').hidden = songs.length > 0;
  $('empty').textContent = total ? 'No songs match your search.' : 'No songs.';
  const playingId = state.queue[state.index]?.id;
  const sel = state.sel;

  $('list').replaceChildren(...songs.map((s, i) => {
    const picked = sel?.has(idx[i]);
    const num = sel ? h('span', { class: `check${picked ? ' on' : ''}` }, icon('check'))
      : s.id === playingId ? h('span', { class: 'eq' }, h('i'), h('i'), h('i')) : String(i + 1);
    const row = h('div', { class: `cols row${s.id === playingId ? ' playing' : ''}${picked ? ' selected' : ''}`, 'data-id': s.id },
      h('span', { class: 'r-num' }, num),
      h('div', { class: 'r-main' },
        s.coverArt ? h('img', { src: api.coverUrl(s.coverArt, 80), loading: 'lazy', alt: '' }) : h('span', { class: 'r-nocover' }),
        h('div', { class: 'r-title' }, s.title)),
      h('span', { class: 'r-sub r-artist' }, s.artist || ''),
      h('span', { class: 'r-sub r-album' }, s.album || ''),
      h('span', { class: 'r-time' }, fmt(s.duration)),
      h('button', {
        class: 'icon-btn', title: 'More', 'aria-label': `Actions for ${s.title}`,
        onclick: (ev) => { ev.stopPropagation(); openSongMenu(ev.currentTarget, s, i); },
      }, icon('more')));
    if (sel) row.setAttribute('aria-selected', String(!!picked));
    row.addEventListener('click', () => (state.sel ? toggleSel(idx[i]) : play(songs, i)));
    // Long press on touch screens (and right click) starts selecting with this song.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (state.sel) toggleSel(idx[i]);
      else startSelecting(idx[i]);
    });
    return row;
  }));
  if (sel) syncSelbar(idx);
}

/* ---------------- multi-select ---------------- */
function syncSelecting() {
  const on = !!state.sel;
  document.body.classList.toggle('selecting', on);
  $('select-toggle').setAttribute('aria-pressed', String(on));
  $('selbar').hidden = !on;
}

function startSelecting(first) {
  closePop();
  state.sel = new Set(first === undefined ? [] : [first]);
  syncSelecting();
  renderList();
}

function stopSelecting() {
  if (!state.sel) return;
  closePop();
  state.sel = null;
  syncSelecting();
  renderList();
}

function toggleSel(i) {
  if (state.sel.has(i)) state.sel.delete(i); else state.sel.add(i);
  renderList();
}

function syncSelbar(visible) {
  const n = state.sel.size;
  $('sel-count').textContent = `${n} selected`;
  for (const id of ['sel-add', 'sel-remove', 'sel-delete']) $(id).disabled = !n;
  $('sel-remove').hidden = state.view.type !== 'playlist';
  const all = visible.length > 0 && visible.every((i) => state.sel.has(i));
  $('sel-all').textContent = all ? 'Select none' : 'Select all';
  $('sel-all').disabled = !visible.length;
}

// Selected positions: the ones on screen in screen order, then any hidden by the search.
function selectedIndexes() {
  const shown = visibleIndexes().filter((i) => state.sel.has(i));
  const seen = new Set(shown);
  return [...shown, ...[...state.sel].filter((i) => !seen.has(i)).sort((a, b) => a - b)];
}
const selectedSongs = () => selectedIndexes().map((i) => state.shown[i]);

$('select-toggle').addEventListener('click', () => (state.sel ? stopSelecting() : startSelecting()));
$('sel-cancel').addEventListener('click', stopSelecting);
$('sel-all').addEventListener('click', () => {
  const visible = visibleIndexes();
  const all = visible.every((i) => state.sel.has(i));
  for (const i of visible) if (all) state.sel.delete(i); else state.sel.add(i);
  renderList();
});
$('sel-add').addEventListener('click', (e) => {
  e.stopPropagation();
  showPlaylistPicker(e.currentTarget, selectedSongs());
});
$('sel-remove').addEventListener('click', async () => {
  const indexes = [...state.sel];
  await guard(async () => {
    await api.removeFromPlaylist(state.view.id, indexes);
    await refreshPlaylists();
    await openView(state.view);
    toast(`Removed ${plural(indexes.length, 'song')} from playlist`);
  });
});
$('sel-delete').addEventListener('click', async () => {
  if (await deleteSongs(selectedSongs())) stopSelecting();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sel && pop.hidden && !document.querySelector('dialog[open]')) stopSelecting();
}, true);   // capture: runs before the menu's own Escape handler closes it

$('del-playlist').addEventListener('click', async () => {
  const pl = state.playlists.find((p) => p.id === state.view.id);
  if (!pl || !(await confirmDlg(`Delete playlist “${pl.name}”?`, 'The songs themselves are kept, only the playlist is removed.'))) return;
  await guard(async () => {
    await api.deletePlaylist(pl.id);
    await refreshPlaylists();
    await openView({ type: 'all' });
    toast('Playlist deleted');
  });
});

/* ---------------- song menu ---------------- */
const pop = $('menu-pop');
function closePop() { pop.hidden = true; }
document.addEventListener('click', (e) => { if (!pop.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
$('scroller').addEventListener('scroll', closePop);

function placePop(anchor) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  pop.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
}

const menuItem = (iconName, text, fn, cls = '') =>
  h('button', { class: cls, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(iconName), text);

function openSongMenu(anchor, song, viewIndex) {
  const inPlaylist = state.view.type === 'playlist';
  pop.replaceChildren(
    menuItem('list', 'Add to playlist…', () => showPlaylistPicker(anchor, [song])),
    ...(inPlaylist ? [menuItem('minus', 'Remove from this playlist', () => { closePop(); removeFromCurrent(viewIndex); })] : []),
    h('hr'),
    menuItem('trash', 'Delete song…', () => { closePop(); deleteSongs([song]); }, 'danger'));
  placePop(anchor);
}

function showPlaylistPicker(anchor, songs) {
  pop.replaceChildren(
    h('div', { class: 'label' }, songs.length === 1 ? 'Add to' : `Add ${songs.length} songs to`),
    ...state.playlists.map((p) => menuItem('music', p.name, () => { closePop(); addSongsTo(p, songs); })),
    ...(state.playlists.length ? [h('hr')] : []),
    menuItem('plus', 'New playlist…', async () => {
      closePop();
      const name = await askName();
      if (name) await guard(async () => {
        const pl = await api.createPlaylist(name, uniqueSongs(songs).map((s) => s.id));
        await refreshPlaylists();
        stopSelecting();
        toast(`${addedText(uniqueSongs(songs))} to “${pl.name}”`);
      });
    }));
  placePop(anchor);
}

const addedText = (songs) => (songs.length === 1 ? 'Added' : `Added ${plural(songs.length, 'song')}`);

const uniqueSongs = (songs) => [...new Map(songs.map((s) => [s.id, s])).values()];

// Songs already in the playlist are skipped (and reported), so nothing ends up in it twice.
async function addSongsTo(playlist, songs) {
  await guard(async () => {
    songs = uniqueSongs(songs);
    const have = new Set(((await api.getPlaylist(playlist.id)).entry || []).map((s) => s.id));
    const fresh = songs.filter((s) => !have.has(s.id));
    const skipped = songs.length - fresh.length;
    if (!fresh.length) {
      toast(songs.length === 1 ? `“${songs[0].title}” is already in “${playlist.name}”`
        : `All ${songs.length} songs are already in “${playlist.name}”`, true);
      return;
    }
    await api.addToPlaylist(playlist.id, fresh.map((s) => s.id));
    await refreshPlaylists();
    if (state.view.type === 'playlist' && state.view.id === playlist.id) await openView(state.view);
    else stopSelecting();
    toast(`${addedText(fresh)} to “${playlist.name}”${skipped ? ` (${plural(skipped, 'song')} already there)` : ''}`);
  });
}

async function removeFromCurrent(viewIndex) {
  // viewIndex is the position on screen; the API wants the position in the playlist itself.
  const idx = visibleIndexes()[viewIndex];
  await guard(async () => {
    await api.removeFromPlaylist(state.view.id, [idx]);
    await refreshPlaylists();
    await openView(state.view);
    toast('Removed from playlist');
  });
}

// Deletes the files one by one (music-api takes one id per call). Returns true if any went.
async function deleteSongs(songs) {
  const one = songs.length === 1;
  const ok = await confirmDlg(one ? `Delete “${songs[0].title}”?` : `Delete ${songs.length} songs?`,
    one ? 'The file is deleted from disk. This can’t be undone.' : 'The files are deleted from disk. This can’t be undone.');
  if (!ok) return false;
  const gone = new Set();
  let failed = 0;
  for (const id of ['sel-add', 'sel-remove', 'sel-delete', 'sel-all']) $(id).disabled = true;
  await guard(async () => {
    try {
      for (const s of songs) {
        if (!one) $('sel-count').textContent = `Deleting ${gone.size + failed + 1} of ${songs.length}…`;
        try {
          await api.deleteSong(s.id);
          gone.add(s.id);
        } catch (e) {
          if (e.code === 401 || e.code === 403) throw e;   // not allowed: stop, guard reports it
          failed++;
        }
      }
    } finally {
      if (gone.size) dropSongs(gone);
      else if (state.sel) renderList();
    }
  });
  if (gone.size) toast(one ? 'Song deleted' : `${plural(gone.size, 'song')} deleted`);
  if (failed) toast(`${plural(failed, 'song')} could not be deleted`, true);
  return gone.size > 0;
}

// Forget deleted songs everywhere: library, current view, play queue.
function dropSongs(ids) {
  const cur = state.queue[state.index];
  const keep = (s) => !ids.has(s.id);
  state.songs = state.songs.filter(keep);
  state.shown = state.shown.filter(keep);
  state.queue = state.queue.filter(keep);
  state.history = [];                     // queue positions moved
  if (state.sel) state.sel = new Set();   // positions moved
  $('all-count').textContent = state.songs.length;
  if (!state.queue.length) resetPlayer();
  else if (ids.has(cur.id)) { state.index = Math.min(state.index, state.queue.length - 1); load(true); }
  else state.index = state.queue.findIndex((s) => s.id === cur.id);
  renderList();
  refreshPlaylists().catch(() => {});
}

/* ---------------- dialogs ---------------- */
function confirmDlg(title, text) {
  const dlg = $('dlg-confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

function askName() {
  const dlg = $('dlg-name'), input = $('name-input');
  input.value = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
    input.focus();
  });
}
// Enter in the name field means Create (the form's default button would be Cancel, the first one).
$('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.target.value.trim()) { e.preventDefault(); $('dlg-name').close('ok'); }
});

/* ---------------- player ---------------- */
function play(list, i) {
  state.queue = list.slice();
  state.index = i;
  state.history = [];
  load(true);
}

let failures = 0;       // songs in a row that failed to play (auto-skip gives up after a few)
let retried = null;     // song id already given one reconnect attempt after a network drop

function load(autoplay, startAt = 0) {
  const s = state.queue[state.index];
  if (!s) return;
  audio.src = api.streamUrl(s.id);
  if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  if (autoplay) audio.play().catch(() => {});
  if (!startAt) saveSession();   // with startAt, wait for the seek (else the saved spot is reset to 0)
  $('np-title').textContent = $('np-fs-title').textContent = s.title;
  $('np-artist').textContent = $('np-fs-artist').textContent = s.artist || '';
  const cover = $('np-cover');
  cover.hidden = !s.coverArt;
  if (s.coverArt) cover.src = api.coverUrl(s.coverArt, 120);
  const fsCover = $('np-fs-cover'), fsTile = $('np-fs-cover-tile');
  fsCover.hidden = !s.coverArt;
  fsTile.hidden = !!s.coverArt;
  if (s.coverArt) fsCover.src = api.coverUrl(s.coverArt, 500);
  document.title = `${s.title} · Music`;
  if ('mediaSession' in navigator) {
    // Several sizes: Android picks one for the notification / lock screen, a bigger one for the wallpaper.
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: s.artist || '', album: s.album || '',
      artwork: s.coverArt
        ? [96, 256, 512].map((n) => ({ src: new URL(api.coverUrl(s.coverArt, n), location.href).href, sizes: `${n}x${n}` }))
        : [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    });
  }
  renderList();
}

function resetPlayer() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.index = -1;
  state.history = [];
  saveSession();
  $('np-title').textContent = $('np-fs-title').textContent = 'Nothing playing';
  $('np-artist').textContent = $('np-fs-artist').textContent = '';
  $('np-cover').hidden = true;
  $('np-fs-cover').hidden = true;
  $('np-fs-cover-tile').hidden = true;
  for (const lbl of curLabels) lbl.textContent = '0:00';
  for (const lbl of durLabels) lbl.textContent = '0:00';
  for (const inp of seekInputs) { inp.value = 0; fill(inp); }
  document.title = 'Music';
  closeNowPlaying();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let i;
  if (state.shuffle && state.queue.length > 1) {
    do { i = Math.floor(Math.random() * state.queue.length); } while (i === state.index);
  } else {
    i = state.index + 1;
    if (i >= state.queue.length) {
      if (state.repeat === 'all' || !auto) i = 0;
      else { audio.pause(); return; }
    }
  }
  if (state.index >= 0) {
    state.history.push(state.index);
    if (state.history.length > 500) state.history.shift();
  }
  state.index = i;
  load(true);
}

// Always goes to the song played before this one (the seek bar is there for restarting a song).
// With shuffle that is the previous random pick, not the neighbour in the list.
function prev() {
  if (!state.queue.length) return;
  let i;
  if (state.history.length) i = state.history.pop();
  else if (state.index > 0) i = state.index - 1;
  else if (state.repeat === 'all') i = state.queue.length - 1;
  else { audio.currentTime = 0; return; }
  state.index = i;
  load(true);
}

function resume() { if (audio.getAttribute('src')) audio.play().catch(() => {}); }
function toggle() {
  if (!audio.getAttribute('src')) return;
  if (audio.paused) resume(); else audio.pause();
}

const playButtons = [$('play'), $('fs-play')];
const shuffleButtons = [$('shuffle'), $('fs-shuffle')];
const repeatButtons = [$('repeat'), $('fs-repeat')];
const seekInputs = [$('seek'), $('fs-seek')];
const curLabels = [$('t-cur'), $('fs-t-cur')];
const durLabels = [$('t-dur'), $('fs-t-dur')];
const volInputs = [$('volume'), $('fs-volume')];

for (const btn of [$('play'), $('fs-play')]) btn.addEventListener('click', toggle);
for (const btn of [$('next'), $('fs-next')]) btn.addEventListener('click', () => next(false));
for (const btn of [$('prev'), $('fs-prev')]) btn.addEventListener('click', prev);
for (const btn of shuffleButtons) btn.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  for (const b of shuffleButtons) b.setAttribute('aria-pressed', String(state.shuffle));
});
for (const btn of repeatButtons) btn.addEventListener('click', () => {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  for (const b of repeatButtons) { b.dataset.mode = state.repeat; b.title = `Repeat: ${state.repeat}`; }
});

const fill = (input) => input.style.setProperty('--p', input.value / input.max);
let seeking = false;
for (const input of seekInputs) {
  input.addEventListener('input', () => {
    seeking = true;
    fill(input);
    const t = (input.value / 1000) * audio.duration;
    for (const other of seekInputs) if (other !== input) { other.value = input.value; fill(other); }
    for (const lbl of curLabels) lbl.textContent = fmt(t);
  });
  input.addEventListener('change', () => { audio.currentTime = (input.value / 1000) * audio.duration; seeking = false; });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!audio.duration || !isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch { /* unsupported combination of values, ignore */ }
}

audio.addEventListener('timeupdate', () => {
  if (seeking || !audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 1000;
  for (const input of seekInputs) { input.value = pct; fill(input); }
  const cur = fmt(audio.currentTime);
  for (const lbl of curLabels) lbl.textContent = cur;
  updatePositionState();
});
audio.addEventListener('loadedmetadata', () => {
  const dur = fmt(audio.duration);
  for (const lbl of durLabels) lbl.textContent = dur;
  updatePositionState();
});
audio.addEventListener('play', () => {
  for (const b of playButtons) { b.classList.add('is-playing'); b.title = 'Pause'; }
  $('app').classList.remove('paused');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  updatePositionState();
});
audio.addEventListener('playing', () => { failures = 0; });
audio.addEventListener('pause', () => {
  for (const b of playButtons) { b.classList.remove('is-playing'); b.title = 'Play'; }
  $('app').classList.add('paused');
  // iOS decides which installed home-screen app owns the lock-screen Now Playing
  // widget partly from this flag; leaving it stale is how a tap can land on a
  // different app (e.g. one that also has an audio/video element, like Catalog).
  // Skipped at the end of a song: the next one starts right away, and a 'paused' blip is what
  // makes Android drop the lock-screen / notification controls between songs.
  if ('mediaSession' in navigator && !audio.ended) navigator.mediaSession.playbackState = 'paused';
  updatePositionState();
  saveSession();
});
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  const s = state.queue[state.index];
  // Wi-Fi often drops for a moment while the phone is locked: reconnect once, at the same spot.
  if (audio.error?.code === MediaError.MEDIA_ERR_NETWORK && s && retried !== s.id) {
    retried = s.id;
    const at = audio.currentTime;
    setTimeout(() => { if (state.queue[state.index] === s) load(true, at); }, 2000);
    return;
  }
  toast('Couldn’t play this song', true);
  // Keep the music going (the screen may be off): skip it, unless nothing seems to play.
  if (++failures < Math.min(3, state.queue.length)) next(true);
});

for (const vol of volInputs) {
  vol.value = pref.get('volume', 80);
  fill(vol);
  vol.addEventListener('input', () => {
    audio.volume = vol.value / 100;
    for (const other of volInputs) if (other !== vol) { other.value = vol.value; fill(other); }
    pref.set('volume', vol.value);
  });
}
audio.volume = volInputs[0].value / 100;

/* ---------------- remember the queue ---------------- */
// Android kills a PWA in the background whenever it wants; reopening it should bring back
// the queue and the spot in the song (paused), like a native player.
let lastSave = 0;
function saveSession() {
  lastSave = Date.now();
  const cur = state.queue[state.index];
  pref.set('session', cur ? JSON.stringify({
    ids: state.queue.map((s) => s.id), index: state.index, history: state.history,
    time: Math.floor(audio.currentTime || 0), shuffle: state.shuffle, repeat: state.repeat,
  }) : '');
}
audio.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 5000) saveSession(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSession(); });
addEventListener('pagehide', saveSession);

function restoreSession() {
  let saved;
  try { saved = JSON.parse(pref.get('session', '') || 'null'); } catch { saved = null; }
  if (!saved?.ids?.length || state.queue.length) return;
  const byId = new Map(state.songs.map((s) => [s.id, s]));
  const cur = saved.ids[saved.index];
  const queue = saved.ids.map((id) => byId.get(id)).filter(Boolean);
  const index = queue.findIndex((s) => s.id === cur);
  if (index < 0) return;                          // the song that was playing is gone
  state.queue = queue;
  state.index = index;
  state.history = queue.length === saved.ids.length ? (saved.history || []).filter((i) => i < queue.length) : [];
  state.shuffle = !!saved.shuffle;
  for (const b of shuffleButtons) b.setAttribute('aria-pressed', String(state.shuffle));
  if (['off', 'all', 'one'].includes(saved.repeat)) state.repeat = saved.repeat;
  for (const b of repeatButtons) { b.dataset.mode = state.repeat; b.title = `Repeat: ${state.repeat}`; }
  load(false, saved.time || 0);
}

/* ---------------- full-screen now playing ---------------- */
function openNowPlaying() {
  if (state.index < 0) return;
  $('now-playing').hidden = false;
}
function closeNowPlaying() { $('now-playing').hidden = true; }
$('now-open').addEventListener('click', openNowPlaying);
$('np-close').addEventListener('click', closeNowPlaying);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('now-playing').hidden) closeNowPlaying(); });

// Swipe down to dismiss, like Spotify/Apple Music. Ignored when the drag starts
// on a control (seek/volume sliders, buttons) so those stay usable.
{
  const panel = $('now-playing');
  let startY = null;
  panel.addEventListener('touchstart', (e) => {
    startY = e.target.closest('input, button, a') ? null : e.touches[0].clientY;
    panel.style.transition = 'none';
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    panel.style.transition = '';
    if (startY === null) return;
    const dy = Math.max(0, (e.changedTouches[0]?.clientY ?? startY) - startY);
    panel.style.transform = '';
    startY = null;
    if (dy > 120) closeNowPlaying();
  });
}

if ('mediaSession' in navigator) {
  // Explicit play/pause (not toggle): Android can send 'play' when already playing, e.g. from a headset.
  navigator.mediaSession.setActionHandler('play', resume);
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  try { navigator.mediaSession.setActionHandler('stop', () => audio.pause()); } catch { /* unsupported */ }
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  // iOS defaults to generic ±10s skip buttons unless seekbackward/seekforward are
  // explicitly disabled — just registering previoustrack/nexttrack isn't enough.
  try { navigator.mediaSession.setActionHandler('seekbackward', null); } catch { /* unsupported */ }
  try { navigator.mediaSession.setActionHandler('seekforward', null); } catch { /* unsupported */ }
  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.fastSeek && 'fastSeek' in audio) { audio.fastSeek(details.seekTime); return; }
      audio.currentTime = details.seekTime;
    });
  } catch { /* seekto not supported */ }
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.key === '/') { e.preventDefault(); $('filter').focus(); }
  else if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
});

/* ---------------- boot ---------------- */
// Service worker: makes the app installable as a real Android app and opens it even when
// the server is briefly unreachable. Only there on a secure origin (see sw.js).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

$('app').classList.add('paused');
const saved = api.loadAuth();
if (saved) {
  state.user = saved.u;
  start();
} else {
  showLogin();
}
