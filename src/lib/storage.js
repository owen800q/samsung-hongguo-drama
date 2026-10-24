// Persistent state in localStorage (the Tizen web runtime keeps it per app).
// Every read tolerates missing or corrupt data; every write tolerates a full quota.

const PREFIX = 'hg.';
const MAX_HISTORY = 200;
const MAX_SEARCHES = 12;

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind) {
  listeners.forEach(fn => { try { fn(kind); } catch (_) {} });
}

// ---------- settings ----------
export const DEFAULT_SETTINGS = {
  autoNext: true,
  playbackRate: 1,
  defaultSource: 'hongguo',
  seekStep: 10,
  cacheNext: true,
  hongguoQuality: 'auto',
};

export function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, read('settings', {}));
}

export function saveSettings(patch) {
  const next = Object.assign(getSettings(), patch);
  write('settings', next);
  emit('settings');
  return next;
}

// ---------- series meta (shared by history and favourites) ----------
function meta(series) {
  return {
    series_id: String(series.series_id),
    series_title: series.series_title || '',
    cover: series.cover || '',
    source: series.source || '',
    total: Number(series.total || series.episode_count) || 0,
  };
}

// ---------- watch history ----------
/** [{ ...meta, vid, vid_index, position, duration, updatedAt, completedEpisode? }] newest first. */
export function getHistory() {
  const list = read('history', []);
  return Array.isArray(list) ? list.filter(x => x && x.series_id) : [];
}

export function getHistoryEntry(seriesId) {
  return getHistory().find(x => x.series_id === String(seriesId)) || null;
}

/** `ended`: the video fired its ended event, the only evidence that an episode was finished. */
export function recordProgress(series, episode, position, duration, ended) {
  const list = getHistory().filter(x => x.series_id !== String(series.series_id));
  const prev = getHistoryEntry(series.series_id);
  const total = Math.max(meta(series).total, (series.episodes && series.episodes.length) || 0);
  const entry = Object.assign(meta(series), {
    total,
    vid: String(episode.vid),
    vid_index: Number(episode.vid_index) || 0,
    position: Math.max(0, Math.floor(position || 0)),
    duration: Math.max(0, Math.floor(duration || 0)),
    updatedAt: Date.now(),
  });
  // Watching the last episode to its end finishes the series; replaying earlier ones keeps that.
  const index = Number(episode.vid_index) || 0;
  const atEnd = ended === true && duration > 0 && isFinite(duration) && position >= duration - Math.min(1, duration * 0.01);
  const done = Math.max(prev && prev.completedEpisode > 0 ? prev.completedEpisode : 0, atEnd && total > 0 && index === total ? index : 0);
  if (done) entry.completedEpisode = done;
  // Remember per-episode positions for the last few episodes so revisiting resumes.
  const positions = Object.assign({}, prev && prev.positions);
  positions[entry.vid] = entry.position;
  const keys = Object.keys(positions);
  if (keys.length > 30) delete positions[keys[0]];
  entry.positions = positions;
  list.unshift(entry);
  write('history', list.slice(0, MAX_HISTORY));
  emit('history');
  return entry;
}

/** Finished up to the latest known episode; `knownTotal` is a newer count (追剧 refresh). */
export function isCompleted(entry, knownTotal) {
  const total = Math.max(Number(entry && entry.total) || 0, Number(knownTotal) || 0);
  return total > 0 && entry.completedEpisode >= total;
}

export function removeHistory(seriesId) {
  write('history', getHistory().filter(x => x.series_id !== String(seriesId)));
  emit('history');
}

export function clearHistory() {
  write('history', []);
  emit('history');
}

// ---------- favourites (追剧) ----------
/** [{ ...meta, seenTotal, addedAt, checkedAt }] newest first. */
export function getFavorites() {
  const list = read('favorites', []);
  return Array.isArray(list) ? list.filter(x => x && x.series_id) : [];
}

export function isFavorite(seriesId) {
  return getFavorites().some(x => x.series_id === String(seriesId));
}

export function toggleFavorite(series) {
  const id = String(series.series_id);
  const list = getFavorites();
  const exists = list.some(x => x.series_id === id);
  const next = exists ? list.filter(x => x.series_id !== id)
    : [Object.assign(meta(series), { seenTotal: meta(series).total, addedAt: Date.now(), checkedAt: Date.now() })].concat(list);
  write('favorites', next);
  emit('favorites');
  return !exists;
}

/** Store the latest episode count; `seen` marks the update as acknowledged. */
export function updateFavorite(seriesId, total, seen) {
  const list = getFavorites().map(x => {
    if (x.series_id !== String(seriesId)) return x;
    const t = Number(total) || x.total;
    return Object.assign({}, x, { total: t, checkedAt: Date.now(), seenTotal: seen ? t : x.seenTotal });
  });
  write('favorites', list);
  emit('favorites');
}

// ---------- search history ----------
export function getSearches() {
  const list = read('searches', []);
  return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

export function addSearch(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return;
  write('searches', [kw].concat(getSearches().filter(x => x !== kw)).slice(0, MAX_SEARCHES));
}

export function clearSearches() {
  write('searches', []);
}
