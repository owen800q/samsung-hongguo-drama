// Upstream 8.5: the website's series pages list only their public episodes, under opaque
// ids, so the episode list comes from the App's detail endpoint and the public stream is
// asked for by the page's id of the episode.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { setTransport } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { fetchEpisodeList, parseEpisodeListHtml } from '../src/sources/hongguo.js';
import { fetchAppEpisodeList, preserveLargeJsonIntegers, videoDetailRequest, setPlaybackPacing } from '../src/sources/app-source.js';

const SID = '7704577081954274328';
// Ids past 2^53, as the App sends them: bare numbers in the JSON.
const VIDS = ['7704580213098679358', '7704580263371623486', '7704580263371623487', '7704580263371623999'];
const TOKENS = ['v1_oDkXQOt3IO2w2-tvzmLab3TvHQo', 'v1_FvjAWTVR-kw4TH6zlaqTSWDCKk8', 'v1_lyytRztaWWw9D0OV7AIThiPIA14'];
const MEDIA = 'https://v3-hgweb.qznovelvod.com/abc/video/tos/cn/x/?a=8662&mime_type=video_mp4';

/** The App's detail answer as raw JSON text, ids unquoted. */
function detailJson({ vids = VIDS, sid = SID, count = vids.length, order = vids.map((_, i) => i + 1), extra = '' } = {}) {
  const rows = vids.map((vid, i) => '{"vid":' + vid + ',"series_id":' + sid + ',"vid_index":' + order[i] +
    ',"title":"简介","disable_play":' + (i === 3) + ',"cover_url":"https://p3.fqnovelpic.com/e' + i + '.jpg"}');
  return '{"code":0,"data":{"video_data":{"series_id":' + sid + ',"series_title":"App 剧名","series_intro":"简介",' +
    '"series_cover":"https://p3.fqnovelpic.com/cover.jpg","episode_cnt":' + count + extra + ',"video_list":[' + rows.join(',') + ']}}}';
}
function webPage(vids, extra = {}) {
  return '<script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { 'player_(series_id)/page': { isSuccess: true, series_id: SID,
    seriesDetail: { series_id: SID, series_name: '官网剧名', series_cover: 'https://p3.douyinpic.com/web.jpg', series_intro: '官网简介',
      tags: ['古风'], vid_list: vids, accessible_episode_cnt: 3, episode_cnt: 71, ...extra } } } }) + ';</script>';
}

/** `app(url, options)` answers the App, `web(url)` the website's pages, `fallback(itemId)` the public stream. */
function fake({ app = () => ({ status: 503, data: '' }), web = () => ({ status: 500, data: '' }), fallback = () => ({ status: 500, data: '' }) }) {
  const log = [];
  setTransport(async (url, options) => {
    const reply = answer => ({ status: answer.status || 200, data: typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data), url, header: () => null });
    if (/device_register/.test(url)) {
      log.push('register');
      return reply({ data: { device_id_str: '4100000000000000001', install_id_str: '4100000000000000002' } });
    }
    if (/video_detail\/v1/.test(url)) { log.push('detail'); return reply(await app(url, options)); }
    if (/fqnovel\.com|snssdk\.com/.test(url)) { log.push('play'); return reply({ data: '' }); }
    if (/fallback-play-info/.test(url)) {
      const id = JSON.parse(options.body).item_id;
      log.push('fallback:' + id);
      return reply(fallback(id));
    }
    if (/hongguoduanju\.com/.test(url)) { log.push('web'); return reply(await web(url)); }
    return reply({ status: 404, data: '' });
  });
  return log;
}
const stream = () => ({ data: { main_url: MEDIA, url_expire: Math.floor(Date.now() / 1000) + 3600, base_resp: { StatusCode: 0 } } });

test.beforeEach(() => setPlaybackPacing(0));
test.after(() => { setPlaybackPacing(); setTransport(null); });

test('64-bit ids keep every digit', () => {
  const raw = '{"vid":7704580263371623487,"series_id" : 7704577081954274328,"other":7704580263371623487,"vid_index":2,"list":[{"vid":7704580263371623999}]}';
  const parsed = JSON.parse(preserveLargeJsonIntegers(raw, ['series_id', 'vid']));
  assert.equal(parsed.vid, '7704580263371623487');
  assert.equal(parsed.series_id, '7704577081954274328');
  assert.equal(parsed.list[0].vid, '7704580263371623999');
  assert.equal(typeof parsed.other, 'number', 'only the named fields are quoted');
  assert.equal(parsed.vid_index, 2);
});

test('the detail request is a v5-signed gzip POST naming the series', () => {
  const identity = { device_id: '4100000000000000001', iid: '4100000000000000002', cdid: 'c' };
  const signed = videoDetailRequest(identity, SID);
  const url = new URL(signed.url);
  assert.equal(url.origin + url.pathname, 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_detail/v1/');
  assert.deepEqual([url.searchParams.get('device_id'), url.searchParams.get('iid'), url.searchParams.get('version_name')],
    [identity.device_id, identity.iid, '7.4.5.32']);
  assert.equal(signed.method, 'POST');
  assert.deepEqual(Object.keys(signed.headers).sort(), ['Accept', 'Content-Encoding', 'Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(signed.body)).toString()), {
    series_id: SID,
    biz_param: { caller_scene: 'single_col', detail_page_version: 0, from_video_id: '', need_all_video_definition: false,
      need_mp4_align: false, source: 4, video_id_type: 1 },
  });
});

test('the App detail answer becomes the episode list, in episode order', async () => {
  const log = fake({ app: () => ({ data: detailJson({ order: [2, 1, 3, 4] }) }) });
  const list = await fetchAppEpisodeList(SID);
  assert.deepEqual(log, ['register', 'detail']);
  assert.deepEqual(list.episodes.map(e => e.vid), [VIDS[1], VIDS[0], VIDS[2], VIDS[3]], 'ids are exact and sorted by vid_index');
  assert.deepEqual(list.episodes.map(e => e.vid_index), [1, 2, 3, 4]);
  assert.deepEqual(list.episodes.map(e => e.locked), [false, false, false, true]);
  assert.deepEqual([list.series_id, list.series_title, list.intro, list.total, list.cover], [SID, 'App 剧名', '简介', 4, 'https://p3.fqnovelpic.com/cover.jpg']);
  await assert.rejects(fetchAppEpisodeList('v1_abc'), /编号无效/);
});

test('an App detail answer that is not this whole series is refused', async () => {
  const bad = {
    'another series': [detailJson({ sid: '7000000000000000000' }), /不一致/],
    'fewer episodes than the series has': [detailJson({ count: 71 }), /不完整/],
    'a repeated episode': [detailJson({ vids: [VIDS[0], VIDS[0]] }), /不完整/],
    'no episodes': [detailJson({ vids: [] }), /为空/],
    'a business refusal': ['{"code":4001,"data":{}}', /暂未提供/],
    'not JSON': ['<html>', /有效数据/],
  };
  for (const name of Object.keys(bad)) {
    fake({ app: () => ({ data: bad[name][0] }) });
    await assert.rejects(fetchAppEpisodeList(SID), bad[name][1], name);
  }
});

test('a device the App turns away is replaced and the detail asked once more', async () => {
  let asked = 0;
  let log = fake({ app: () => ({ data: ++asked === 1 ? '{"code":110001}' : detailJson() }) });
  assert.equal((await fetchAppEpisodeList(SID)).total, 4);
  assert.deepEqual(log, ['register', 'detail', 'register', 'detail']);
  log = fake({ app: () => ({ data: '{"code":110001}' }) });
  await assert.rejects(fetchAppEpisodeList(SID), error => error.businessCode === 110001);
  assert.equal(log.filter(x => x === 'detail').length, 2, 'only once more');
});

test('a page that lists only its public episodes is not an episode list', () => {
  const page = parseEpisodeListHtml(webPage(TOKENS), SID);
  assert.deepEqual([page.complete, page.episodes.length, page.total, page.web_accessible_episodes], [false, 0, 71, 3]);
  assert.deepEqual(page.public_tokens, TOKENS);
  // Numeric ids, but fewer than the series has: a preview too.
  const preview = parseEpisodeListHtml(webPage(['11', '12', '13']), SID);
  assert.deepEqual([preview.complete, preview.episodes.length, preview.public_tokens.length], [false, 0, 0]);
  const full = parseEpisodeListHtml(webPage(['11', '12', '13'], { episode_cnt: 3 }), SID);
  assert.deepEqual([full.complete, full.total, full.episodes.map(e => e.vid).join()], [true, 3, '11,12,13']);
  assert.throws(() => parseEpisodeListHtml(webPage(['11', TOKENS[0]]), SID), /异常/, 'mixed ids');
  assert.throws(() => parseEpisodeListHtml(webPage([TOKENS[0], TOKENS[0]]), SID), /异常/);
});

test('the list is the App\'s, with tags and the public range from the website', async () => {
  fake({ app: () => ({ data: detailJson() }), web: () => ({ data: webPage(TOKENS) }) });
  const list = await fetchEpisodeList(SID, { force: true });
  assert.deepEqual(list.episodes.map(e => e.vid), VIDS);
  assert.ok(list.episodes.every(e => e.title === ''), 'the introduction is not repeated as each episode\'s title');
  assert.equal(list.episodes[3].locked, true);
  assert.deepEqual([list.series_title, list.total, list.web_accessible_episodes, list.tags.join(), list.intro, list.source],
    ['官网剧名', 4, 3, '古风', '简介', 'hongguo']);
  assert.deepEqual(list.public_tokens, TOKENS);
});

test('the App list does not wait long for a website that is down or slow', async () => {
  fake({ app: () => ({ data: detailJson() }) });
  let list = await fetchEpisodeList(SID, { force: true });
  assert.deepEqual([list.series_title, list.total, list.web_accessible_episodes, list.tags.length], ['App 剧名', 4, null, 0]);
  fake({ app: () => ({ data: detailJson() }), web: () => new Promise(resolve => setTimeout(resolve, 400, { data: webPage(TOKENS) })) });
  const started = Date.now();
  list = await fetchEpisodeList(SID, { force: true, webGrace: 30 });
  assert.ok(Date.now() - started < 350, 'the grace period, not the page, decides');
  assert.deepEqual([list.total, list.tags.length], [4, 0]);
});

test('with the App down, only a page that lists every episode stands in', async () => {
  fake({ web: () => ({ data: webPage(['11', '12'], { episode_cnt: 2, accessible_episode_cnt: 2 }) }) });
  const list = await fetchEpisodeList(SID, { force: true });
  assert.deepEqual([list.episodes.map(e => e.vid).join(), list.web_accessible_episodes], ['11,12', 2]);
  fake({ web: () => ({ data: webPage(TOKENS) }) });
  await assert.rejects(fetchEpisodeList(SID, { force: true }), /只列出公开的前几集.*App 接口.*请稍后重试/);
  fake({ app: () => ({ data: '' }), web: () => ({ data: webPage(TOKENS) }) });
  await assert.rejects(fetchEpisodeList(SID, { force: true }), /接口返回空响应/);
});

test('a public episode is asked for by the page\'s id and reported under its own', async () => {
  // The App gives the list but no streams, as in November 2026.
  const world = { app: () => ({ data: detailJson() }), web: () => ({ data: webPage(TOKENS) }),
    fallback: id => /^v1_/.test(id) ? stream() : { status: 400, data: '' } };
  let log = fake(world);
  await fetchEpisodeList(SID, { force: true });
  const info = await getPlayInfo(VIDS[1], SID, { force: true });
  assert.deepEqual([info.url, info.vid, info.source, info.quality, info.contentKey], [MEDIA, VIDS[1], 'web', '360p', null]);
  assert.deepEqual(log.filter(x => /^fallback/.test(x)), ['fallback:' + TOKENS[1]], 'the second episode asks with the second id');
  assert.ok(log.indexOf('play') >= 0 && log.indexOf('play') < log.indexOf('fallback:' + TOKENS[1]), 'the App is still asked first');
  // An episode past the page's ids is asked for by its number, and the answer explains the range.
  log = fake(world);
  await assert.rejects(getPlayInfo(VIDS[3], SID, { force: true }), /仅提供前 3 集，第 4 集/);
  assert.deepEqual(log.filter(x => /^fallback/.test(x)), ['fallback:' + VIDS[3]]);
});

test('the page\'s ids are read on demand when the list came without them', async () => {
  let pages = 0;
  const world = { app: () => ({ data: detailJson() }), fallback: id => id === TOKENS[0] ? stream() : { status: 400, data: '' } };
  fake(world);
  const list = await fetchEpisodeList(SID, { force: true });
  assert.deepEqual(list.public_tokens, []);
  const log = fake({ ...world, web: url => { if (/\/player\/\d+$/.test(url)) pages++; return /\/player\/\d+$/.test(url) ? { data: webPage(TOKENS) } : { status: 500, data: '' }; } });
  const info = await getPlayInfo(VIDS[0], SID, { force: true });
  assert.deepEqual([info.url, info.vid], [MEDIA, VIDS[0]]);
  assert.equal(pages, 1);
  assert.equal(log[log.length - 1], 'fallback:' + TOKENS[0]);
});

test('an episode page is asked for by the page\'s id, and an unprotected one plays', async () => {
  const file = 'https://hongguoduanju.com/video/public/' + TOKENS[1] + '/360p.mp4';
  const episodePage = protectedPlayback => '<script type="application/ld+json">' + JSON.stringify({ '@type': 'VideoObject',
    url: 'https://hongguoduanju.com/player/' + SID + '/' + TOKENS[1], contentUrl: file }) + '</script><script>window._ROUTER_DATA = ' +
    JSON.stringify({ loaderData: { 'player_(series_id)/(vid)/page': { isSuccess: true, series_id: SID, vid: TOKENS[1], protectedPlayback,
      seriesDetail: { series_id: SID }, publicVideoSeo: { available: true, seriesId: SID, itemId: TOKENS[1] } } } }) + ';</script>';
  const asked = [];
  const world = protectedPlayback => ({ app: () => ({ data: detailJson() }), fallback: () => stream(),
    web: url => { asked.push(new URL(url).pathname); return { data: /\/v1_/.test(url) ? episodePage(protectedPlayback) : webPage(TOKENS) }; } });
  let log = fake(world(false));
  await fetchEpisodeList(SID, { force: true });
  asked.length = 0;
  let info = await getPlayInfo(VIDS[1], SID, { force: true });
  assert.deepEqual([info.url, info.vid, info.source], [file, VIDS[1], 'web']);
  assert.deepEqual(asked, ['/player/' + SID + '/' + TOKENS[1]], 'one page, under the site\'s id');
  assert.ok(log.indexOf('play') < 0, 'the App is not asked for an episode the site serves');
  // Protected (every page in November 2026): its file is a preview, so the App and then the public stream are asked.
  log = fake(world(true));
  info = await getPlayInfo(VIDS[1], SID, { force: true });
  assert.equal(info.url, MEDIA);
  assert.ok(log.indexOf('play') >= 0);
  // An episode the site lists no id for has no page to ask.
  asked.length = 0;
  await getPlayInfo(VIDS[3], SID, { force: true }).catch(() => {});
  assert.deepEqual(asked, []);
});
