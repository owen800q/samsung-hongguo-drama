// Offline: the App source's address list and the player's fallback along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, HttpError } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { resolvePlayback, setPlayMaxBytes, prefetch } from '../src/media/playback.js';
import { resetPlaybackDevice } from '../src/sources/playback-device.js';

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

const DEVICE_ID = '4123456789012345678';
const INSTALL_ID = '4987654321098765432';

/**
 * Fakes the website (down), device registration, the App API and the media CDN; returns
 * the requested URLs. `model(vid)` replaces the App API's video model.
 */
function fake({ outer, api, model, register, media = {} } = {}) {
  const requested = [];
  resetPlaybackDevice();
  setTransport(async (url, options) => {
    requested.push(url);
    const reply = (status, data, type = 'application/json') => ({ status, data, url, header: n => (n === 'content-type' ? type : null) });
    if (/hongguoduanju\.com/.test(url)) return reply(500, '');
    if (/device_register/.test(url)) {
      if (register) return register(reply);
      // Precise IDs come as strings; the numbers have already lost digits.
      return reply(200, JSON.stringify({ server_time: 1, device_id: 4123456789012345000, install_id: 4987654321098765000,
        device_id_str: DEVICE_ID, install_id_str: INSTALL_ID, new_user: 1 }));
    }
    if (/api5-normal/.test(url)) {
      if (api) return api(reply, url, options);
      const vid = JSON.parse(new TextDecoder().decode(options.body)).mixed_video_id_map[1004][0];
      const videoModel = model ? model(vid) : { fallback_api: 'https://vas.snssdk.com/video/fallback' };
      return reply(200, JSON.stringify({ code: 0, data: { [vid]: { video_model: JSON.stringify(videoModel) } } }));
    }
    if (/vas\.snssdk\.com/.test(url)) return reply(200, JSON.stringify(outer || { code: 0, video_info: { code: 0, data: { video_list: videoList() } } }));
    if (media[url]) return media[url](reply, options);
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

test('playback uses one registered anonymous device, not random signed IDs', async () => {
  const seen = [];
  const requested = fake({ api: (reply, url, options) => {
    seen.push({ url, headers: options.headers });
    const vid = JSON.parse(new TextDecoder().decode(options.body)).mixed_video_id_map[1004][0];
    return reply(200, JSON.stringify({ code: 0, data: { [vid]: { video_model: { video_list: Object.values(videoList()) } } } }));
  } });
  await getPlayInfo('9000000000000000021', '', { force: true });
  await getPlayInfo('9000000000000000022', '', { force: true });
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 1, 'registered once per app session');
  for (const { url, headers } of seen) {
    const q = new URL(url).searchParams;
    assert.equal(q.get('device_id'), DEVICE_ID);
    assert.equal(q.get('iid'), INSTALL_ID);
    assert.match(q.get('cdid'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!('x-gorgon' in headers) && !('x-medusa' in headers));
  }
});

test('a direct video model is used without the fallback API', async () => {
  const requested = fake({ model: () => ({ video_list: Object.values(videoList()) }) });
  const info = await getPlayInfo('9000000000000000023', '', { force: true });
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main1080, MEDIA.backup1080, MEDIA.main720]);
  assert.ok(info.variants.every(v => v.contentKey === KEY));
  assert.ok(!requested.some(u => /snssdk/.test(u)));
});

test('a direct stream without a key is skipped unless marked unencrypted', async () => {
  const list = Object.values(videoList());
  delete list[1].spade_a;
  list[0].encrypt_info = { encrypt: false };
  delete list[0].spade_a;
  fake({ model: () => ({ video_list: list }) });
  const info = await getPlayInfo('9000000000000000024', '', { force: true });
  assert.deepEqual(info.variants.map(v => [v.url, v.contentKey]), [[MEDIA.main720, null]]);
});

test('an empty App answer or failed registration is not mistaken for a network problem', async () => {
  fake({ api: reply => reply(200, '') });
  await assert.rejects(getPlayInfo('9000000000000000025', '', { force: true }), /均未提供播放地址/);
  const requested = fake({ register: reply => reply(200, JSON.stringify({ device_id: 0, install_id: 0 })) });
  await assert.rejects(getPlayInfo('9000000000000000026', '', { force: true }), /均未提供播放地址/);
  // Within the pause after a failed registration, nothing registers or asks the App API again.
  await assert.rejects(getPlayInfo('9000000000000000027', '', { force: true }), /均未提供播放地址/);
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 1);
  assert.ok(!requested.some(u => /api5-normal/.test(u)));
});

test('a registration without a connection is reported as a network problem', async () => {
  fake({ register: () => { throw new HttpError('网络连接失败', 0); } });
  await assert.rejects(getPlayInfo('9000000000000000028', '', { force: true }), /网络连接失败/);
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

test('actual size outranks a wrong quality label', async () => {
  fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: {
    video_1: { codec_type: 'h264', definition: '1080p', main_url: MEDIA.main720, video_meta: { vwidth: 360, vheight: 640 }, spade_a: spadeFor(KEY) },
    video_2: { codec_type: 'h264', definition: '720p', main_url: MEDIA.main1080, video_meta: { vwidth: 1080, vheight: 1920 }, spade_a: spadeFor(KEY) },
  } } } } });
  const info = await getPlayInfo('9000000000000000007', '', { force: true });
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main1080, MEDIA.main720]);
});

function sizedList() {
  return {
    video_1: { codec_type: 'bytevc1', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, spade_a: spadeFor(KEY) },
    video_2: { codec_type: 'bytevc1', definition: '1080p', main_url: MEDIA.main1080, backup_url_list: [MEDIA.backup1080], vwidth: 1080, vheight: 1920, spade_a: spadeFor(KEY) },
    video_3: { codec_type: 'h264', definition: '1080p', main_url: 'https://v1.qznovelvod.com/unsized.mp4', spade_a: spadeFor(KEY) },
  };
}

test('a chosen quality uses the closest confirmed stream and skips the website', async () => {
  const requested = fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: sizedList() } } } });
  const info = await getPlayInfo('9000000000000000008', '123', { force: true, quality: '720p' });
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main720, MEDIA.main1080, MEDIA.backup1080]);
  assert.ok(!requested.some(u => /hongguoduanju\.com/.test(u)));
  const hd = await getPlayInfo('9000000000000000008', '123', { force: true, quality: '1080p' });
  assert.deepEqual(hd.variants.map(v => v.url), [MEDIA.main1080, MEDIA.backup1080]);
});

test('a chosen quality that is missing is reported, not downgraded', async () => {
  const list = sizedList();
  delete list.video_2;
  fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: list } } } });
  await assert.rejects(getPlayInfo('9000000000000000009', '', { force: true, quality: '1080p' }), /1080P.*未自动降级.*设置/);
});

test('each quality setting looks up its own streams', async () => {
  const requested = fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: sizedList() } } } });
  await assert.rejects(resolvePlayback('9000000000000000010', '', { quality: '1080p' }), /HTTP 404/);
  await assert.rejects(resolvePlayback('9000000000000000010', '', { quality: '720p' }), /HTTP 404/);
  assert.deepEqual(requested.filter(u => /qznovelvod/.test(u)), [MEDIA.main1080, MEDIA.backup1080, MEDIA.main720, MEDIA.main1080, MEDIA.backup1080]);
});

test('an episode too large for the TV memory moves on to another address, then says so', async () => {
  setPlayMaxBytes(8);
  let aborted = false;
  const requested = fake({ media: {
    // Declared size: the transfer is abandoned on its first progress event.
    [MEDIA.backup1080]: (reply, options) => {
      options.cancel.subscribe(() => { aborted = true; });
      options.onProgress(4, 20);
      if (aborted) throw new HttpError('已取消', -1);
      return reply(200, new ArrayBuffer(20), 'video/mp4');
    },
    // Undeclared size: checked once it has arrived.
    [MEDIA.main720]: reply => reply(200, new ArrayBuffer(12), 'video/mp4'),
  } });
  try {
    await assert.rejects(resolvePlayback('9000000000000000011', '', { force: true }), err => {
      assert.equal(err.code, 'MEDIA_TOO_LARGE');
      assert.match(err.message, /过大.*红果清晰度改为 720P/);
      return true;
    });
  } finally {
    setPlayMaxBytes();
  }
  assert.ok(aborted, 'the oversized download is aborted');
  assert.deepEqual(requested.filter(u => /qznovelvod/.test(u)), [MEDIA.main1080, MEDIA.backup1080, MEDIA.main720]);
});

test('a prefetch that hit the size cap is not downloaded again', async () => {
  const requested = fake({ media: {
    [MEDIA.main1080]: (reply, options) => {
      options.onProgress(4, 100 * 1024 * 1024);
      if (options.cancel.cancelled) throw new HttpError('已取消', -1);
      return reply(200, new ArrayBuffer(20), 'video/mp4');
    },
  } });
  assert.equal(await prefetch('9000000000000000030', '', null, 'auto'), false);
  const downloads = requested.filter(u => /qznovelvod/.test(u)).length;
  assert.equal(downloads, 1);
  assert.equal(await prefetch('9000000000000000030', '', null, 'auto'), false);
  assert.equal(requested.filter(u => /qznovelvod/.test(u)).length, downloads);
});
