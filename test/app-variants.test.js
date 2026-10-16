// Offline: the App source's address list and the player's fallback along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, HttpError } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { resolvePlayback } from '../src/media/playback.js';

const KEY = '0123456789abcdef0123456789abcdef';

// Inverse of deriveContentKey in src/sources/app-source.js.
function spadeFor(hex) {
  const work = new Array(39).fill(0);
  for (let i = 0; i < 32; i++) work[i + 1] = hex.charCodeAt(i);
  const raw = [0];
  let a = 85; let b = 246;
  for (let i = 0; i < work.length; i++) {
    const previous = i & 1 ? a : b;
    const pop = i.toString(2).split('1').length - 1;
    const old = ((work[i] + 21 + pop) & 255) ^ previous;
    if (i & 1) a = old; else b = old;
    raw.push(old);
  }
  raw.push(0);
  raw[0] = raw[1] ^ raw[2];
  return Buffer.from(raw).toString('base64');
}

const MEDIA = {
  main1080: 'https://v1.qznovelvod.com/1080.mp4',
  backup1080: 'https://v2.qznovelvod.com/1080.mp4',
  main720: 'https://v1.qznovelvod.com/720.mp4',
};

function videoList() {
  return {
    video_1: { codec_type: 'bytevc1', definition: '720p', main_url: MEDIA.main720, spade_a: spadeFor(KEY) },
    video_2: { codec_type: 'bytevc1', definition: '1080p', main_url: MEDIA.main1080, backup_url_list: [MEDIA.backup1080, MEDIA.main1080], spade_a: spadeFor(KEY) },
    video_3: { codec_type: 'av1', definition: '1080p', main_url: 'https://v1.qznovelvod.com/av1.mp4', spade_a: spadeFor(KEY) },
  };
}

/** Fakes the website (down), the App API and the media CDN; returns the requested URLs. */
function fake({ outer, api, media = {} } = {}) {
  const requested = [];
  setTransport(async (url, options) => {
    requested.push(url);
    const reply = (status, data, type = 'application/json') => ({ status, data, url, header: n => (n === 'content-type' ? type : null) });
    if (/hongguoduanju\.com/.test(url)) return reply(500, '');
    if (/api5-normal/.test(url)) {
      if (api) return api();
      const vid = JSON.parse(new TextDecoder().decode(options.body)).mixed_video_id_map[1004][0];
      return reply(200, JSON.stringify({ code: 0, data: { [vid]: { video_model: JSON.stringify({ fallback_api: 'https://vas.snssdk.com/video/fallback' }) } } }));
    }
    if (/vas\.snssdk\.com/.test(url)) return reply(200, JSON.stringify(outer || { code: 0, video_info: { code: 0, data: { video_list: videoList() } } }));
    if (media[url]) return media[url](reply);
    return reply(404, new ArrayBuffer(0), 'text/plain');
  });
  return requested;
}

test('app source lists every compatible address, best first', async () => {
  fake();
  const info = await getPlayInfo('9000000000000000001', '', { force: true });
  assert.equal(info.url, MEDIA.main1080);
  assert.equal(info.contentKey, KEY);
  assert.equal(info.quality, '1080p');
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main1080, MEDIA.backup1080, MEDIA.main720]);
  assert.ok(info.variants.every(v => v.contentKey === KEY && v.codec === 'hevc' && v.source === 'app'));
});

test('app source rejects a fallback response with an error code or no model', async () => {
  fake({ outer: { code: 0, video_info: { code: 10001, data: { video_list: videoList() } } } });
  await assert.rejects(getPlayInfo('9000000000000000002', '', { force: true }), /均未提供播放地址/);
  fake({ outer: { code: 0, video_info: {} } });
  await assert.rejects(getPlayInfo('9000000000000000003', '', { force: true }), /均未提供播放地址/);
});

test('a lost connection is reported as a network problem', async () => {
  fake({ api: () => { throw new HttpError('网络连接失败', 0); } });
  await assert.rejects(getPlayInfo('9000000000000000004', '', { force: true }), /网络连接失败/);
});

test('a failed download falls back to the next address', async () => {
  const requested = fake({
    media: { [MEDIA.backup1080]: reply => reply(200, new TextEncoder().encode('<html>expired</html>').buffer, 'text/html') },
  });
  await assert.rejects(resolvePlayback('9000000000000000005', '', { force: true }), /HTTP 404/);
  assert.deepEqual(requested.filter(u => /qznovelvod/.test(u)), [MEDIA.main1080, MEDIA.backup1080, MEDIA.main720]);
});

test('a download timeout does not try the other addresses', async () => {
  const requested = fake({ media: { [MEDIA.main1080]: () => { throw new HttpError('请求超时', 0); } } });
  await assert.rejects(resolvePlayback('9000000000000000006', '', { force: true }), /请求超时/);
  assert.deepEqual(requested.filter(u => /qznovelvod/.test(u)), [MEDIA.main1080]);
});
