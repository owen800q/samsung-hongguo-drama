// Live tests against the real sources (need network). Each retries once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useNodeTransport } from './node-transport.js';
import { browseList, search, fetchSeries, getPlayInfo, browseCategories } from '../src/sources/index.js';

useNodeTransport();
const retry = async fn => { try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, 1500)); return fn(); } };
const okList = r => { assert.ok(r.success, r.error); assert.ok(r.results.length > 0); return r; };

test('hongguo catalog + ranking', async () => {
  const r = okList(await retry(async () => okList(await browseList({ source: 'hongguo', category: 'real-drama', page: 1 }))));
  assert.ok(r.genres.length > 0 && r.hasMore && r.nextPage === 2);
  okList(await retry(async () => okList(await browseList({ source: 'hongguo', category: 'hot-drama' }))));
  assert.equal(browseCategories('hongguo').length, 7);
});

test('hongguo search', async () => {
  const r = await retry(async () => okList(await search('总裁', { source: 'hongguo' })));
  assert.ok(r.results.every(x => /^\d+$/.test(x.series_id) && x.source === 'hongguo'));
});

test('hongguo series + web and app play info', async () => {
  const list = await retry(async () => okList(await browseList({ source: 'hongguo', category: 'real-drama' })));
  const s = await retry(() => fetchSeries(list.results[0].series_id));
  assert.ok(s.episodes.length > 10, 'needs >10 episodes');
  const web = await retry(() => getPlayInfo(s.episodes[0].vid, s.series_id));
  assert.match(web.url, /^https:/);
  assert.equal(web.contentKey, null);
  const app = await retry(() => getPlayInfo(s.episodes[9].vid, s.series_id));
  assert.match(app.url, /^https:/);
  assert.match(app.contentKey, /^[0-9a-f]{32}$/);
});

test('xifan browse/search/series', async () => {
  const b = await retry(async () => okList(await browseList({ source: 'xifan' })));
  assert.ok(b.genres.length > 0);
  await retry(async () => okList(await search('总裁', { source: 'xifan' })));
  const s = await retry(() => fetchSeries(b.results[0].series_id));
  assert.ok(s.episodes.length > 0);
  const free = s.episodes.find(e => !e.locked);
  if (free) assert.match((await retry(() => getPlayInfo(free.vid, s.series_id))).url, /^https:/);
});

test('hema browse/search/series', async () => {
  const b = await retry(async () => okList(await browseList({ source: 'hema' })));
  await retry(async () => okList(await search('总裁', { source: 'hema' })));
  const s = await retry(() => fetchSeries(b.results[0].series_id));
  assert.ok(s.episodes.length > 0);
  const free = s.episodes.find(e => !e.locked);
  if (free) assert.match((await retry(() => getPlayInfo(free.vid, s.series_id))).url, /^https:/);
});

test('search all sources tolerates partial failure', async () => {
  const r = await retry(async () => okList(await search('总裁', { source: 'all' })));
  const sources = new Set(r.results.map(x => x.source));
  assert.ok(sources.size >= 2, 'results from at least 2 sources: ' + Array.from(sources));
});

test('playback: direct URL and decrypted blob', async () => {
  const { resolvePlayback, release } = await import('../src/media/playback.js');
  const list = await retry(async () => okList(await browseList({ source: 'hongguo', category: 'real-drama' })));
  const s = await retry(() => fetchSeries(list.results[1].series_id));
  const direct = await retry(() => resolvePlayback(s.episodes[0].vid, s.series_id));
  assert.equal(direct.encrypted, false);
  assert.match(direct.src, /^https:/);
  const phases = new Set();
  const enc = await retry(() => resolvePlayback(s.episodes[9].vid, s.series_id, { onProgress: p => phases.add(p) }));
  assert.equal(enc.encrypted, true);
  assert.match(enc.src, /^blob:/);
  assert.ok(phases.has('decrypt'), Array.from(phases).join()); // Node transport reports no download progress
  const again = await resolvePlayback(s.episodes[9].vid, s.series_id);
  assert.equal(again.src, enc.src);
  // Reconnecting drops the cached episode and fetches it again.
  const fresh = await retry(() => resolvePlayback(s.episodes[9].vid, s.series_id, { force: true }));
  assert.equal(fresh.encrypted, true);
  assert.notEqual(fresh.src, enc.src);
  release(s.episodes[9].vid);
});

test('playback: prefetch hands off to the player and cancels when abandoned', async () => {
  const { resolvePlayback, prefetch, release } = await import('../src/media/playback.js');
  const { CancelToken } = await import('../src/lib/http.js');
  const list = await retry(async () => okList(await browseList({ source: 'hongguo', category: 'real-drama' })));
  const s = await retry(() => fetchSeries(list.results[2].series_id));
  // Abandoned before anyone plays it: the prefetch gives up.
  const dropped = new CancelToken();
  const abandoned = prefetch(s.episodes[10].vid, s.series_id, dropped);
  dropped.cancel();
  assert.equal(await abandoned, false);
  // The player joins an in-flight prefetch; cancelling the prefetch afterwards keeps it going.
  const token = new CancelToken();
  const warm = prefetch(s.episodes[9].vid, s.series_id, token);
  const phases = new Set();
  const playing = retry(() => resolvePlayback(s.episodes[9].vid, s.series_id, { onProgress: p => phases.add(p) }));
  token.cancel();
  const enc = await playing;
  assert.equal(await warm, true);
  assert.equal(enc.encrypted, true);
  assert.ok(phases.has('decrypt'), Array.from(phases).join());
  release(s.episodes[9].vid);
});
