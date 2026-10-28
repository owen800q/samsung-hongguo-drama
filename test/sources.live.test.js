// Live tests against the real sources (need network). Each retries once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useNodeTransport } from './node-transport.js';
import { browseList, search, fetchSeries, getPlayInfo, browseCategories, findNextSeasons } from '../src/sources/index.js';
import { seasonTitle } from '../src/sources/seasons.js';

useNodeTransport();
const retry = async fn => { try { return await fn(); } catch (e) { await new Promise(r => setTimeout(r, 1500)); return fn(); } };
const okList = r => { assert.ok(r.success, r.error); assert.ok(r.results.length > 0); return r; };

// Series marked protectedPlayback only expose a ~10 s preview on the website, so their first
// episode must come from the App source. Prefer a series the website really serves; since
// late 2026 the site protects nearly every series, so the App fallback is checked instead.
async function firstEpisodeSeries(results, skip = 0) {
  let fallback = null;
  for (const item of results.slice(skip, skip + 8)) {
    const s = await retry(() => fetchSeries(item.series_id));
    if (s.episodes.length <= 10) continue;
    const info = await retry(() => getPlayInfo(s.episodes[0].vid, s.series_id));
    if (info.contentKey === null) return { s, web: true };
    assert.match(info.contentKey, /^[0-9a-f]{32}$/, 'a protected first episode falls back to the App source');
    fallback = fallback || s;
  }
  assert.ok(fallback, 'needs a series with >10 episodes');
  return { s: fallback, web: false };
}

test('hongguo catalog + ranking', async () => {
  const r = okList(await retry(async () => okList(await browseList({ source: 'hongguo', category: 'real-drama', page: 1 }))));
  assert.ok(r.genres.length > 0 && r.hasMore && r.nextPage === 2);
  okList(await retry(async () => okList(await browseList({ source: 'hongguo', category: 'hot-drama' }))));
  assert.equal(browseCategories('hongguo').length, 7);
});

test('hongguo search', async () => {
  const r = await retry(async () => okList(await search('总裁', { source: 'hongguo' })));
  assert.ok(r.results.every(x => /^\d+$/.test(x.series_id) && x.source === 'hongguo'));
  // The search endpoint pages; a later page brings new series.
  assert.ok(r.hasMore && r.more.indexOf('hongguo') >= 0, 'a broad keyword has a second page');
  const next = await retry(async () => okList(await search('总裁', { source: 'hongguo', page: 2, only: r.more })));
  assert.ok(next.results.some(x => !r.results.some(y => y.series_id === x.series_id)));
});

test('hongguo search matches a title written with other punctuation', async () => {
  const r = await retry(async () => okList(await search('谁说纨绔，不能当状元', { source: 'hongguo' })));
  assert.equal(r.results[0].relevance, 0, r.results.slice(0, 3).map(x => x.series_title).join());
  assert.ok(r.results.some(x => /第[二2]季$/.test(x.series_title)), 'its seasons are listed too');
});

test('hongguo series + web and app play info', async () => {
  const list = await retry(async () => okList(await browseList({ source: 'hongguo', category: 'real-drama' })));
  const { s, web: public_ } = await firstEpisodeSeries(list.results);
  const web = await retry(() => getPlayInfo(s.episodes[0].vid, s.series_id));
  assert.match(web.url, /^https:/);
  assert.equal(web.contentKey === null, public_);
  const app = await retry(() => getPlayInfo(s.episodes[9].vid, s.series_id));
  assert.match(app.url, /^https:/);
  assert.match(app.contentKey, /^[0-9a-f]{32}$/);
});

test('season search and 查找下一季 on a multi-season series', async () => {
  // Any 西饭 season-2 title; its source then decides whether later seasons exist.
  const pool = await retry(async () => okList(await search('第二季', { source: 'xifan' })));
  const second = pool.results.find(x => seasonTitle(x.series_title).season === 2);
  assert.ok(second, 'needs a season-2 title');
  const base = seasonTitle(second.series_title).base;
  const r = await retry(async () => okList(await search(base, { source: 'xifan' })));
  const tiers = r.results.map(x => x.relevance);
  assert.deepEqual(tiers, tiers.slice().sort(), 'title matches come first');
  assert.ok(r.results.some(x => x.series_id === second.series_id), 'the season search finds season 2 from its bare name');
  const next = await retry(() => findNextSeasons(second));
  assert.ok(next.success, next.error);
  for (const x of next.results) {
    const t = seasonTitle(x.series_title);
    assert.ok(t.base === base && t.season > 2 && x.series_id.indexOf('xifan:') === 0, x.series_title);
  }
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
  const { s, web } = await firstEpisodeSeries(list.results, 1);
  const direct = await retry(() => resolvePlayback(s.episodes[0].vid, s.series_id));
  assert.equal(direct.encrypted, !web);
  assert.match(direct.src, web ? /^https:/ : /^blob:/);
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
  release(s.episodes[0].vid);
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
  assert.equal(await abandoned, 'cancelled');
  // The player joins an in-flight prefetch; cancelling the prefetch afterwards keeps it going.
  const token = new CancelToken();
  const warm = prefetch(s.episodes[9].vid, s.series_id, token);
  const phases = new Set();
  const playing = retry(() => resolvePlayback(s.episodes[9].vid, s.series_id, { onProgress: p => phases.add(p) }));
  token.cancel();
  const enc = await playing;
  assert.equal(await warm, 'ready');
  assert.equal(enc.encrypted, true);
  assert.ok(phases.has('decrypt'), Array.from(phases).join());
  release(s.episodes[9].vid);
});
