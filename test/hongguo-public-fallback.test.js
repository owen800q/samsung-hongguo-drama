// Upstream 8.0/8.1: the website's public 360P stream is the last resort after the App source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { fetchPublicFallbackPlayUrl } from '../src/sources/hongguo.js';
import { setPlaybackPacing } from '../src/sources/app-source.js';

const MEDIA = 'https://v3-hgweb.qznovelvod.com/abc/video/tos/cn/x/?a=8662&mime_type=video_mp4';
const KEY_SPADE_STREAM = 'https://v1.qznovelvod.com/720.mp4';

/** The website's pages are down; `fallback(vid)` answers the public endpoint, `app` the App. */
function fake({ fallback, app = () => '' }) {
  const log = [];
  setTransport(async (url, options) => {
    const reply = (status, data) => ({ status, data, url, header: () => null });
    if (/fallback-play-info/.test(url)) {
      log.push('fallback');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      const answer = fallback(JSON.parse(options.body).item_id);
      return reply(answer.status || 200, typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data));
    }
    if (/hongguoduanju\.com/.test(url)) return reply(500, '');
    if (/device_register/.test(url)) return reply(200, JSON.stringify({ device_id_str: '4100000000000000001', install_id_str: '4100000000000000002' }));
    if (/api5-normal|reading\.snssdk\.com/.test(url)) { log.push('app'); return reply(200, app(url)); }
    return reply(404, '');
  });
  return log;
}
const answer = (main_url, extra = {}) => ({ data: { main_url, url_expire: Math.floor(Date.now() / 1000) + 3600, base_resp: { StatusCode: 0, StatusMessage: '' }, ...extra } });

test('the public fallback answer becomes a clear 360P website stream', async () => {
  fake({ fallback: vid => { assert.equal(vid, '9100000000000000001'); return answer(MEDIA.replace(/&/g, '\\u0026')); } });
  assert.deepEqual(await fetchPublicFallbackPlayUrl('9100000000000000001'),
    { url: MEDIA, contentKey: null, codec: 'h264', quality: '360p', source: 'web', vid: '9100000000000000001' });
  assert.equal(await fetchPublicFallbackPlayUrl('not-a-vid'), null);
});

test('an unusable public fallback answer is not played', async () => {
  const bad = [
    answer('http://v3-hgweb.qznovelvod.com/a.mp4'),
    answer('https://user:pw@v3-hgweb.qznovelvod.com/a.mp4'),
    answer('https://qznovelvod.com.example.org/a.mp4'),
    answer('https://192.168.1.2/a.mp4'),
    answer(''),
    answer(MEDIA, { url_expire: Math.floor(Date.now() / 1000) - 10 }),
    answer(MEDIA, { base_resp: { StatusCode: 4 } }),
    { data: '[]' },
  ];
  for (const item of bad) {
    fake({ fallback: () => item });
    assert.equal(await fetchPublicFallbackPlayUrl('9100000000000000002'), null, JSON.stringify(item));
  }
  // The site saying the episode is not public is told apart from an outage.
  fake({ fallback: () => ({ status: 403, data: { error: 'public_fallback_unavailable' } }) });
  await assert.rejects(fetchPublicFallbackPlayUrl('9100000000000000003'), error => error.publicLimited === true);
  fake({ fallback: () => ({ status: 502, data: '' }) });
  await assert.rejects(fetchPublicFallbackPlayUrl('9100000000000000004'), error => !error.publicLimited);
});

test('the public stream is used only after the App source gave nothing', async () => {
  setPlaybackPacing(0);
  // Every App endpoint answers empty: the website's public stream plays.
  let log = fake({ fallback: () => answer(MEDIA) });
  const info = await getPlayInfo('9100000000000000010', '', { force: true });
  assert.equal(info.url, MEDIA);
  assert.equal(info.contentKey, null);
  assert.equal(info.source, 'web');
  assert.equal(log[log.length - 1], 'fallback');
  assert.ok(log.indexOf('fallback') === log.length - 1 && log.length > 1, 'the App was asked first');
  // The App answers: its stream is kept and the public endpoint is not asked.
  setPlaybackPacing(0);
  const stream = { codec_type: 'h264', definition: '720p', main_url: KEY_SPADE_STREAM, vwidth: 720, vheight: 1280, encrypt_info: { encrypt: false } };
  log = fake({ fallback: () => answer(MEDIA), app: () => JSON.stringify({ code: 0, data: { '9100000000000000011': { video_model: { video_list: [stream] } } } }) });
  assert.equal((await getPlayInfo('9100000000000000011', '', { force: true })).url, KEY_SPADE_STREAM);
  assert.deepEqual(log, ['app']);
  // A chosen quality never falls back to the 360P stream.
  setPlaybackPacing(0);
  log = fake({ fallback: () => answer(MEDIA) });
  await assert.rejects(getPlayInfo('9100000000000000012', '', { force: true, quality: '1080p' }), /未自动降级/);
  assert.ok(log.indexOf('fallback') < 0);
  setPlaybackPacing(0);
});

test('an episode the site does not offer publicly says so when the App is empty too', async () => {
  setPlaybackPacing(0);
  fake({ fallback: () => ({ status: 403, data: { error: 'public_fallback_unavailable' } }) });
  await assert.rejects(getPlayInfo('9100000000000000020', '', { force: true }), /官网公开片源不提供本集.*官方 App 观看/);
  setPlaybackPacing(0);
  fake({ fallback: () => ({ status: 500, data: '' }) });
  await assert.rejects(getPlayInfo('9100000000000000021', '', { force: true }), /均未提供播放地址/);
  setPlaybackPacing(0);
});
