// 红果 search through the website's search endpoint, and search-wide behaviour (looser
// searches, paging, time budget), against a stub transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport } from '../src/lib/http.js';
import { parseSearchResponse, search as hongguoSearch, fetchEpisodeList } from '../src/sources/hongguo.js';
import { search } from '../src/sources/index.js';
import { relaxedQueries, searchText, relevance, rankResults } from '../src/sources/seasons.js';

const entry = (id, title, extra = {}) => ({ doc_type: 23, name: title, keyword: id,
  video_data: { series_id: id, series_title: title, episode_cnt: 80, series_cover: 'https://p3-novel.byteimg.com/a.image',
    category_list: [{ name: '逆袭' }], series_intro: '简介 &amp; 更多', hot_score_data: { text: '1万热度' }, ...extra } });
const payload = (list, more = {}) => ({ searchList: list, totalCount: String(list.length), pageNum: 1, totalPages: 1, hasMore: false, ...more });

// Routes requests by URL; each handler gets the parsed URL and returns { status, data } or throws.
function stub(handler) {
  const calls = [];
  setTransport(async (url, options) => {
    const u = new URL(url);
    calls.push(u);
    const res = await handler(u, options);
    return { status: res.status || 200, data: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), url, header: () => null };
  });
  return calls;
}
const query = u => u.searchParams.get('query') || u.searchParams.get('keyword');
const sourceOfUrl = u => /hongguoduanju/.test(u.host) ? 'hongguo' : /xifan/.test(u.host) ? 'xifan' : 'hema';

test.after(() => setTransport(null));

test('title matching ignores width, case, spaces and punctuation', () => {
  assert.equal(searchText('言出法随，诸天万界 我说了算！'), '言出法随诸天万界我说了算');
  assert.equal(searchText('ＡＢＣ·《剧》'), 'abc剧');
  assert.equal(relevance('言出法随 诸天万界 我说了算', '言出法随，诸天万界我说了算'), 0);
  assert.equal(relevance('言出法随诸天万界我说了算第二季', '言出法随，诸天万界'), 1);
  assert.equal(relevance('任何剧', '，。'), 2, 'a keyword of only punctuation matches nothing');
  // Season titles keep their brackets: only matching ignores punctuation.
  assert.deepEqual(relaxedQueries('言出法随，诸天万界我说了算'), ['言出法随诸天万界我说了算', '言出法随']);
  assert.deepEqual(relaxedQueries('言出法随 诸天'), ['言出法随诸天', '言出法随']);
  assert.deepEqual(relaxedQueries('总裁'), []);
  assert.deepEqual(relaxedQueries('a，总裁夫人'), ['a总裁夫人', '总裁夫人']);
});

test('looser-search results rank after title matches and before other results', () => {
  const r = rankResults([
    { source: 'hongguo', series_id: '1', series_title: '无关' },
    { source: 'hongguo', series_id: '2', series_title: '补搜到的', fuzzy: true },
    { source: 'hongguo', series_id: '3', series_title: '剧 名' },
  ], '剧名');
  assert.deepEqual(r.map(x => x.series_id), ['3', '2', '1']);
});

test('search response: video_data entries, keyword-only entries, duplicates and paging', () => {
  const r = parseSearchResponse(payload([
    entry('7673067074104593432', '谁说纨绔不能当状元'),
    { doc_type: 23, name: '谁说纨绔不能当状元第二季', keyword: '7677874167550594110', video_data: {} },
    entry('7673067074104593432', '谁说纨绔不能当状元'),
    entry('12', '编号太短'),
    entry('7600000000000000001', ''),
  ], { totalCount: '211', totalPages: 22, hasMore: true }));
  assert.deepEqual(r.results.map(x => x.series_id), ['7673067074104593432', '7677874167550594110']);
  assert.equal(r.results[1].series_title, '谁说纨绔不能当状元第二季');
  assert.deepEqual(r.results[0].tags, ['逆袭']);
  assert.equal(r.results[0].intro, '简介 & 更多');
  assert.equal(r.results[0].heat, '1万热度');
  assert.deepEqual([r.total, r.totalPages, r.hasMore], [211, 22, true]);
  assert.deepEqual(parseSearchResponse(payload([])).results, []);
});

test('an unusable search response is an error, not "no results"', () => {
  assert.throws(() => parseSearchResponse(payload([{ doc_type: 1, name: '相关搜索' }])), e => e.retry === false);
  assert.throws(() => parseSearchResponse({ list: [] }), e => e.retry === false);
  assert.throws(() => parseSearchResponse('<html></html>'), e => e.retry === true);
  assert.throws(() => parseSearchResponse(''), e => e.retry === true);
  assert.throws(() => parseSearchResponse({ code: 'E1', message: '忙' }), e => e.retry === true && /忙/.test(e.message));
});

test('红果 search calls the endpoint, retries a server error once and caches the page', async () => {
  let n = 0;
  const calls = stub(() => (++n === 1 ? { status: 502, data: 'bad gateway' } : { data: payload([entry('7600000000000000001', '重试剧')], { hasMore: true }) }));
  const r = await hongguoSearch('重试剧', 1);
  assert.ok(r.success, r.error);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/api/search/result');
  assert.equal(calls[0].searchParams.get('aid'), '8662');
  assert.equal(calls[0].searchParams.get('page'), '1');
  assert.deepEqual([r.hasMore, r.nextPage], [true, 2]);
  await hongguoSearch('重试剧', 1);
  assert.equal(calls.length, 2, 'a recent page is reused');
});

test('红果 search does not retry a changed endpoint, and reports it', async () => {
  const calls = stub(() => ({ status: 404, data: 'not found' }));
  const r = await hongguoSearch('接口变化剧', 1);
  assert.equal(r.success, false);
  assert.match(r.error, /接口已变化/);
  assert.equal(calls.length, 1);
  const late = await hongguoSearch('接口变化剧', 51);
  assert.equal(late.success, false, 'pages stop at 50');
});

test('红果 search stays within the time it is given', async () => {
  const calls = stub(() => ({ status: 503, data: '' }));
  const r = await hongguoSearch('预算剧', 1, { deadline: Date.now() + 500 });
  assert.equal(r.success, false);
  assert.match(r.error, /超时/);
  assert.equal(calls.length, 0);
});

test('a keyword without a title match is searched again without punctuation, then by its first clause', async () => {
  const kw = '言出法随，诸天万界我说了算';
  const calls = stub(u => {
    const q = query(u);
    if (sourceOfUrl(u) !== 'hongguo') return { data: { ret: 0, result: { elements: [] } } };
    if (q === kw.normalize('NFKC')) return { data: payload([entry('7600000000000000010', '别的剧')]) };
    if (q === '言出法随诸天万界我说了算') return { data: payload([entry('7600000000000000011', '相近的剧')]) };
    if (q === '言出法随') return { data: payload([entry('7600000000000000012', '言出法随 诸天万界 我说了算')]) };
    return { data: payload([]) };
  });
  const r = await search(kw, { source: 'hongguo' });
  assert.ok(r.success, r.error);
  assert.deepEqual(r.relaxed, ['言出法随诸天万界我说了算', '言出法随']);
  assert.deepEqual(r.results.map(x => x.series_id), ['7600000000000000012', '7600000000000000011', '7600000000000000010']);
  assert.equal(r.results[0].relevance, 0);
  assert.equal(r.results[1].fuzzy, true);
  assert.equal(calls.filter(u => sourceOfUrl(u) === 'hongguo').length, 3);

  // A title match on the first try needs no looser search (only the usual season search).
  const exact = stub(u => ({ data: payload([entry('7600000000000000013', '总裁')]) }));
  const e = await search('总裁', { source: 'hongguo' });
  assert.deepEqual(e.relaxed, []);
  assert.deepEqual(exact.map(query), ['总裁', '总裁第二季', '总裁第2季']);
});

test('later pages only ask the sources that have more, and keep a failed source for a retry', async () => {
  const pages = [];
  stub(u => {
    const src = sourceOfUrl(u);
    pages.push(src + ':' + (u.searchParams.get('page') || u.searchParams.get('pageIndex') || 'post'));
    if (src === 'hongguo') return { data: payload([entry('760000000000000002' + (u.searchParams.get('page') || '0'), '分页剧' + u.searchParams.get('page'))], { hasMore: true }) };
    if (src === 'xifan') return { data: { ret: 0, result: { hasMore: false, elements: [] } } };
    return { status: 500, data: '' };
  });
  const first = await search('分页剧', { source: 'all' });
  assert.ok(first.success);
  assert.deepEqual(first.more, ['hongguo']);
  assert.equal(first.hasMore, true);
  pages.length = 0;
  const second = await search('分页剧', { source: 'all', page: 2, only: first.more });
  assert.deepEqual(pages, ['hongguo:2']);
  assert.equal(second.results[0].series_title, '分页剧2');

  stub(u => ({ status: 503, data: '' }));
  const failed = await search('分页剧', { source: 'all', page: 3, only: ['hongguo'] });
  assert.equal(failed.success, false);
  assert.deepEqual(failed.more, ['hongguo'], 'the failed page can be asked again');
});

test('the episode list comes from the current player object and must name the requested series', async () => {
  const SID = '7673067074104593432';
  const html = model => '<script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { 'player_(series_id)/page': model } }) + ';</script>' +
    // A recommendation further down the page must never be read as this series.
    '<script>{"vid_list":["1","2"]}</script>';
  const detail = extra => ({ isSuccess: true, series_id: SID, seriesDetail: { series_id: SID, series_name: '剧', vid_list: ['11', '12', '13'], accessible_episode_cnt: 2, tags: ['逆袭'], ...extra } });
  let model = detail();
  stub(() => ({ data: html(model) }));
  const s = await fetchEpisodeList(SID, { force: true });
  assert.deepEqual(s.episodes.map(e => e.vid), ['11', '12', '13']);
  assert.deepEqual([s.series_title, s.web_accessible_episodes, s.tags[0]], ['剧', 2, '逆袭']);
  model = detail({ series_id: '7000000000000000000' });
  await assert.rejects(fetchEpisodeList(SID, { force: true }), /不一致/);
  model = detail({ vid_list: ['11', '11'] });
  await assert.rejects(fetchEpisodeList(SID, { force: true }), /异常/);
  model = { isSuccess: false };
  await assert.rejects(fetchEpisodeList(SID, { force: true }), /不一致/);
});

test('the episode list races the player and detail pages and retries a hung or failed round', async () => {
  const SID = '7673067074104593432';
  const page = (key, vids) => '<script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { [key]: {
    isSuccess: true, seriesDetail: { series_id: SID, series_name: '剧', vid_list: vids } } } }) + ';</script>';
  // A request that never answers until it is cancelled, like a hung CDN edge.
  const hang = options => new Promise((_, reject) => options.cancel.subscribe(() => reject(new Error('已取消'))));
  const cancelled = [];
  const hung = options => { options.cancel.subscribe(() => cancelled.push(true)); return hang(options); };

  // The player page hangs; the detail page of the same series answers.
  let calls = stub((u, options) => u.pathname === '/detail' ? { data: page('detail_page', ['21', '22']) } : hung(options));
  let s = await fetchEpisodeList(SID, { force: true, hedgeMs: 5000 });
  assert.deepEqual(s.episodes.map(e => e.vid), ['21', '22']);
  assert.equal(calls.length, 2, 'one round asks both pages');
  assert.equal(cancelled.length, 1, 'the hung player request is cancelled');

  // The whole first round hangs; a second round on fresh connections answers.
  let n = 0;
  cancelled.length = 0;
  calls = stub((u, options) => ++n <= 2 ? hung(options) : { data: page('player_(series_id)/page', ['31']) });
  s = await fetchEpisodeList(SID, { force: true, hedgeMs: 30 });
  assert.deepEqual(s.episodes.map(e => e.vid), ['31']);
  assert.equal(cancelled.length, 2, 'the first round is cancelled once the second answers');

  // Connection resets retry at once, three rounds at most, then say so in words.
  calls = stub(() => { throw new Error('网络连接失败'); });
  await assert.rejects(fetchEpisodeList(SID, { force: true, hedgeMs: 5000 }), /^Error: 红果分集加载超时或连接中断，请重试$/);
  assert.equal(calls.length, 6);
  calls = stub(u => u.pathname === '/detail' ? { status: 502, data: '' } : { data: page('detail_page', ['1']).replace(SID, '7000000000000000000') });
  await assert.rejects(fetchEpisodeList(SID, { force: true, hedgeMs: 5000 }), /不一致/);
});
