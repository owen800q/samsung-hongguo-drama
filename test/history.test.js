import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = { localStorage: {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
} };
const { recordProgress, getHistoryEntry, isCompleted } = await import('../src/lib/storage.js');

const series = (total, id = 's1') => ({ series_id: id, series_title: '剧', total,
  episodes: Array.from({ length: total }, (_, i) => ({ vid: 'v' + (i + 1), vid_index: i + 1 })) });

test('only the ended event at the end of the last episode marks a series finished', () => {
  store.clear();
  recordProgress(series(3), series(3).episodes[2], 100, 100, true);
  assert.equal(isCompleted(getHistoryEntry('s1')), true);
  for (const [ep, pos, dur, ended] of [[3, 100, 100, false], [3, 5, 100, true], [2, 100, 100, true], [3, 100, 0, true], [3, 100, Infinity, true]]) {
    store.clear();
    recordProgress(series(3), series(3).episodes[ep - 1], pos, dur, ended);
    assert.equal(isCompleted(getHistoryEntry('s1')), false, JSON.stringify([ep, pos, dur, ended]));
  }
});

test('replaying keeps the finished state; new episodes make it unfinished again', () => {
  store.clear();
  recordProgress(series(3), series(3).episodes[2], 100, 100, true);
  recordProgress(series(3), series(3).episodes[0], 5, 100);
  assert.equal(isCompleted(getHistoryEntry('s1')), true);
  // A 追剧 refresh found a 4th episode.
  assert.equal(isCompleted(getHistoryEntry('s1'), 4), false);
  recordProgress(series(4), series(4).episodes[0], 5, 100);
  assert.equal(isCompleted(getHistoryEntry('s1')), false);
  recordProgress(series(4), series(4).episodes[3], 99.5, 100, true);
  assert.equal(isCompleted(getHistoryEntry('s1')), true);
});

test('old records without completion evidence are unfinished', () => {
  store.clear();
  store.set('hg.history', JSON.stringify([{ series_id: 's1', total: 3, vid_index: 3, position: 100, duration: 100 }]));
  assert.equal(isCompleted(getHistoryEntry('s1')), false);
});
