// Upstream 8.5: the website lists only its public episodes, as opaque tokens; the full list
// comes from the App's detail endpoint and the tokens ask for the website's public stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { setTransport } from '../src/lib/http.js';
import { getPlayInfo, fetchSeries } from '../src/sources/index.js';
import { fetchEpisodeList, parseEpisodeListHtml } from '../src/sources/hongguo.js';
import { videoDetailRequest, fetchAppEpisodeList, preserveLargeJsonIntegers, setPlaybackPacing } from '../src/sources/app-source.js';

const SID = '7710503618658454553';
const TOKENS = ['v1_OrVn8y1MeMEceiaS9W_vEwgRLqA', 'v1_pJI0GeMn7pTPZTxhN0yZHzstMLU', 'v1_oAEoWW_gX3fXX5IbNxyIKIoIZU4'];
const VIDS = ['7710505458045291545', '7710505735989251097', '7710505500860763161', '7710505569462783000', '7710505675230563353'];
const MEDIA = 'https://v26-hgweb.qznovelvod.com/abc/video/tos/cn/x/?a=8662&mime_type=video_mp4';
const REGISTERED = { device_id_str: '4100000000000000001', install_id_str: '4100000000000000002' };

const page = detail => '<script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { 'player_(series_id)/page': {
  isSuccess: true, series_id: SID, seriesDetail: Object.assign({ series_id: SID, series_name: '温夜潮湿', series_cover: 'https://p3.example.com/web.image',
    series_intro: '官网简介', tags: ['爱情'], episode_cnt: VIDS.length, accessible_episode_cnt: 3, vid_list: TOKENS }, detail) } } }) + ';</script>';
// The App writes ids as bare 64-bit numbers in places: build the answer as text.
const appDetail = ({ vids = VIDS, count = vids.length, sid = SID, code = 0, extra = '' } = {}) => '{"code":' + code + ',"data":{"video_data":{"series_id":' + sid +
  ',"series_title":"App 剧名","series_cover":"https://p3.example.com/app.image","series_intro":"App 简介","episode_cnt":' + count + ',"video_list":[' +
  vids.map((vid, i) => '{"vid":' + vid + ',"vid_index":' + (i + 1) + ',"series_id":"' + sid + '","title":"每集都一样的简介","disable_play":' + (i === 4) + extra + '}').reverse().join(',') + ']}}}';

/** `web(url)` answers the website's pages, `detail()` the App's detail endpoint, `fallback(item)` the public stream. */
function fake({ web = () => ({ data: page() }), detail = () => appDetail(), fallback = () => ({ status: 400, data: '{"error":"public_fallback_unavailable"}' }) } = {}) {
  const log = [];
  setTransport(async (url, options) => {
    const reply = (status, data) => ({ status, data, url, header: () => null });
    if (/fallback-play-info/.test(url)) {
      const item = JSON.parse(options.body).item_id;
      log.push('fallback:' + item);
      const answer = fallback(item);
      return reply(answer.status || 200, typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data));
    }
    if (/hongguoduanju\.com/.test(url)) {
      log.push('web:' + new URL(url).pathname);
      const answer = web(url);
      return reply(answer.status || 200, answer.data || '');
    }
    if (/device_register/.test(url)) { log.push('register'); return reply(200, JSON.stringify(REGISTERED)); }
    if (/video_detail\/v1/.test(url)) { log.push('detail'); return reply(200, detail(url, options)); }
    if (/api5-normal|reading\.snssdk\.com/.test(url)) { log.push('app'); return reply(200, ''); }
    return reply(404, '');
  });
  setPlaybackPacing(0);
  return log;
}
test.after(() => { setTransport(null); setPlaybackPacing(); });

test('the detail request is a signed gzip POST for that series', () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const signed = videoDetailRequest(identity, SID);
  const url = new URL(signed.url);
  assert.equal(signed.method, 'POST');
  assert.equal(url.origin + url.pathname, 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_detail/v1/');
  assert.equal(url.searchParams.get('version_code'), '74532');
  assert.equal(url.searchParams.get('device_id'), identity.device_id);
  assert.equal(url.searchParams.get('iid'), identity.iid);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(signed.body)).toString()), {
    series_id: SID,
    biz_param: { caller_scene: 'single_col', detail_page_version: 0, from_video_id: '', need_all_video_definition: false, need_mp4_align: false, source: 4, video_id_type: 1 },
  });
  assert.deepEqual(Object.keys(signed.headers).sort(), ['Accept', 'Content-Encoding', 'Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
  assert.equal(signed.headers['x-ss-stub'].toLowerCase(), createHash('md5').update(signed.body).digest('hex'));
});

test('64-bit ids survive JSON parsing', () => {
  const raw = '{"series_id":7710503618658454553,"vid": 7710505458045291545 ,"vid_index":12,"duration":7710505458045291545,"x":{"vid":"7710505458045291546"}}';
  const parsed = JSON.parse(preserveLargeJsonIntegers(raw, ['series_id', 'vid']));
  assert.deepEqual([parsed.series_id, parsed.vid, parsed.vid_index, parsed.x.vid], ['7710503618658454553', '7710505458045291545', 12, '7710505458045291546']);
  assert.equal(typeof parsed.duration, 'number');
});

test('the App detail answer becomes the whole episode list, in order, ids intact', async () => {
  const log = fake();
  const list = await fetchAppEpisodeList(SID);
  assert.deepEqual(list.episodes.map(e => e.vid), VIDS);
  assert.deepEqual(list.episodes.map(e => e.vid_index), [1, 2, 3, 4, 5]);
  assert.deepEqual(list.episodes.map(e => e.locked), [false, false, false, false, true]);
  assert.ok(list.episodes.every(e => e.title === ''), 'the per-episode title is the series intro, not a title');
  assert.deepEqual([list.series_id, list.series_title, list.cover, list.intro, list.total], [SID, 'App 剧名', 'https://p3.example.com/app.image', 'App 简介', 5]);
  assert.deepEqual(log, ['register', 'detail']);
  await assert.rejects(fetchAppEpisodeList('v1_abc'), /编号无效/);
});

test('an App detail answer that is not this whole series is refused', async () => {
  const bad = {
    不一致: appDetail({ sid: '7000000000000000001' }),
    不完整: appDetail({ count: VIDS.length + 1 }),
    '不完整 ': appDetail({ vids: VIDS.concat(VIDS[0]), count: 0 }),
    异常: appDetail({ vids: ['"v1_abcdefghij"'] }),
    为空: appDetail({ vids: [] }),
    拒绝请求: appDetail({ code: 5 }),
    空响应: '',
  };
  for (const why of Object.keys(bad)) {
    fake({ detail: () => bad[why] });
    await assert.rejects(fetchAppEpisodeList(SID), new RegExp(why.trim()), why);
  }
});

test('a device the App turns away is replaced once for the detail request', async () => {
  let asked = 0;
  let log = fake({ detail: () => (++asked === 1 ? appDetail({ code: 110001 }) : appDetail()) });
  assert.equal((await fetchAppEpisodeList(SID)).total, 5);
  assert.deepEqual(log, ['register', 'detail', 'register', 'detail']);
  log = fake({ detail: () => appDetail({ code: 110001 }) });
  await assert.rejects(fetchAppEpisodeList(SID), /拒绝请求/);
  assert.deepEqual(log, ['register', 'detail', 'register', 'detail']);
});

test('a page of public tokens is read as an incomplete list', () => {
  const web = parseEpisodeListHtml(page(), SID);
  assert.deepEqual([web.complete, web.total, web.episodes.length, web.listed, web.episode_count, web.web_accessible_episodes], [false, 0, 0, 3, 5, 3]);
  assert.deepEqual(web.web_tokens, TOKENS);
  // A page that lists every episode id is still complete; one that lists a few is not.
  const full = parseEpisodeListHtml(page({ vid_list: VIDS }), SID);
  assert.deepEqual([full.complete, full.total, full.web_tokens], [true, 5, null]);
  assert.equal(parseEpisodeListHtml(page({ vid_list: VIDS.slice(0, 3) }), SID).complete, false);
  assert.equal(parseEpisodeListHtml(page({ vid_list: VIDS, episode_cnt: undefined }), SID).complete, true);
  assert.throws(() => parseEpisodeListHtml(page({ vid_list: [TOKENS[0], VIDS[1]] }), SID), /异常/);
  assert.throws(() => parseEpisodeListHtml(page({ vid_list: [TOKENS[0], TOKENS[0]] }), SID), /异常/);
});

test('the series is the App list with the website details and public range', async () => {
  const log = fake();
  const s = await fetchSeries(SID, { force: true });
  assert.deepEqual(s.episodes.map(e => e.vid), VIDS);
  assert.deepEqual([s.series_title, s.cover, s.intro, s.tags[0], s.total, s.web_accessible_episodes, s.source],
    ['温夜潮湿', 'https://p3.example.com/web.image', '官网简介', '爱情', 5, 3, 'hongguo']);
  assert.equal(s.episodes[4].locked, true);
  assert.equal(log.filter(x => x === 'detail').length, 1);
  // A website that lists every episode id again needs no App request.
  const whole = fake({ web: () => ({ data: page({ vid_list: VIDS }) }) });
  assert.equal((await fetchEpisodeList(SID, { force: true })).total, 5);
  assert.ok(whole.indexOf('detail') < 0 && whole.indexOf('register') < 0, whole.join());
});

test('the App list alone is used when the website is down, and neither is an error that says why', async () => {
  fake({ web: () => ({ status: 502 }) });
  const s = await fetchEpisodeList(SID, { force: true, hedgeMs: 5000 });
  assert.deepEqual([s.series_title, s.cover, s.total, s.web_accessible_episodes, s.web_tokens], ['App 剧名', 'https://p3.example.com/app.image', 5, null, null]);
  fake({ detail: () => '' });
  await assert.rejects(fetchEpisodeList(SID, { force: true }), /^Error: 红果官网只列出 3 \/ 5 集，App 接口未返回完整分集，请稍后重试$/);
  fake({ web: () => ({ status: 502 }), detail: () => '' });
  await assert.rejects(fetchEpisodeList(SID, { force: true, hedgeMs: 5000 }), /红果官网暂不可用（HTTP 502）/);
});

test('a public episode asks the public stream with its token, after the App, without the removed pages', async () => {
  const log = fake({ fallback: item => (item === TOKENS[2] ? { data: { main_url: MEDIA, url_expire: Math.floor(Date.now() / 1000) + 3600, base_resp: { StatusCode: 0 } } } : { status: 400, data: '{}' }) });
  await fetchEpisodeList(SID, { force: true });
  const info = await getPlayInfo(VIDS[2], SID, { force: true });
  assert.deepEqual(info, { url: MEDIA, contentKey: null, codec: 'h264', quality: '360p', source: 'web', vid: VIDS[2] });
  assert.equal(log[log.length - 1], 'fallback:' + TOKENS[2]);
  assert.ok(log.indexOf('app') > 0 && log.indexOf('app') < log.length - 1, 'the App was asked first');
  assert.ok(!log.some(x => /^web:\/player\/.+\//.test(x)), 'no per-episode page is asked: ' + log.join());
  // The lookup reuses the list it was shown from, however long ago within five minutes.
  assert.deepEqual([log.filter(x => x === 'detail').length, log.filter(x => x === 'web:/player/' + SID).length], [1, 1], log.join());
  // Past the public range there is no token: the episode id is asked, and the error names the range.
  const past = fake();
  await fetchEpisodeList(SID, { force: true });
  await assert.rejects(getPlayInfo(VIDS[3], SID, { force: true }), /仅提供前 3 集，第 4 集/);
  assert.equal(past[past.length - 1], 'fallback:' + VIDS[3]);
});
