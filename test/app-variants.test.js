// Offline: the App source's address list and the player's fallback along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, HttpError } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { resolvePlayback, setPlayMaxBytes } from '../src/media/playback.js';
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

const REGISTERED = { device_id_str: '4100000000000000001', install_id_str: '4100000000000000002' };

/** Fakes the website (down), the App API and the media CDN; returns the requested URLs. */
function fake({ outer, api, media = {} } = {}) {
  const requested = [];
  setTransport(async (url, options) => {
    requested.push(url);
    const reply = (status, data, type = 'application/json') => ({ status, data, url, header: n => (n === 'content-type' ? type : null) });
    if (/hongguoduanju\.com/.test(url)) return reply(500, '');
    if (/device_register/.test(url)) return reply(200, JSON.stringify(REGISTERED));
    if (/api5-normal/.test(url)) {
      if (api) return api(url);
      const vid = JSON.parse(new TextDecoder().decode(options.body)).mixed_video_id_map[1004][0];
      return reply(200, JSON.stringify({ code: 0, data: { [vid]: { video_model: JSON.stringify({ fallback_api: 'https://vas.snssdk.com/video/fallback' }) } } }));
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

// Upstream 3.9: the playback API now answers random per-request IDs with an empty body.
test('app playback registers one anonymous device and sends it with every request', async () => {
  resetPlaybackDevice();
  const requested = fake();
  await getPlayInfo('9000000000000000012', '', { force: true });
  await getPlayInfo('9000000000000000013', '', { force: true });
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 1);
  const calls = requested.filter(u => /api5-normal/.test(u)).map(u => new URL(u).searchParams);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(q => q.get('device_id') === REGISTERED.device_id_str && q.get('iid') === REGISTERED.install_id_str));
  assert.ok(calls.every(q => /^[0-9a-f-]{36}$/.test(q.get('cdid'))));
});

test('the current inline model plays without asking the fallback address', async () => {
  const requested = fake({ api: url => ({ status: 200, url, header: () => null,
    data: JSON.stringify({ code: 0, data: { '9000000000000000014': { video_model: JSON.stringify({ video_list: [
      { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
      { codec_type: 'bytevc1', definition: '1080p', main_url: MEDIA.main1080, vwidth: 1080, vheight: 1920, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
    ] }) } } }) }) });
  const info = await getPlayInfo('9000000000000000014', '', { force: true });
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main1080, MEDIA.main720]);
  assert.ok(info.variants.every(v => v.contentKey === KEY));
  assert.ok(!requested.some(u => /snssdk/.test(u)));
});

test('an inline stream without its key is not played as clear video', async () => {
  fake({ api: url => ({ status: 200, url, header: () => null,
    data: JSON.stringify({ code: 0, data: { '9000000000000000015': { video_model: { video_list: [
      { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280 },
    ] } } } }) }) });
  await assert.rejects(getPlayInfo('9000000000000000015', '', { force: true }), /均未提供播放地址/);
  fake({ api: url => ({ status: 200, url, header: () => null,
    data: JSON.stringify({ code: 0, data: { '9000000000000000016': { video_model: { video_list: [
      { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { encrypt: false } },
    ] } } } }) }) });
  assert.equal((await getPlayInfo('9000000000000000016', '', { force: true })).contentKey, null);
});

test('a failed registration is shared, then retried after 30 s', async () => {
  resetPlaybackDevice();
  let registrations = 0;
  setTransport(async url => {
    if (/device_register/.test(url)) registrations++;
    return { status: 200, data: /device_register/.test(url) ? '{"code":0}' : '', url, header: () => null };
  });
  const now = Date.now;
  try {
    await assert.rejects(getPlayInfo('9000000000000000017', '', { force: true }), /均未提供播放地址|设备注册失败/);
    await assert.rejects(getPlayInfo('9000000000000000018', '', { force: true }));
    assert.equal(registrations, 1);
    const later = now() + 31000;
    Date.now = () => later;
    await assert.rejects(getPlayInfo('9000000000000000019', '', { force: true }));
    assert.equal(registrations, 2);
  } finally {
    Date.now = now;
    resetPlaybackDevice();
  }
});

// Upstream 4.4: the API can answer one device with empty bodies mid-run while a new one works.
function renewingTransport({ emptyFor = () => false, failRegistration = () => false } = {}) {
  const log = { registrations: 0, devices: [] };
  setTransport(async (url, options) => {
    const reply = (status, data) => ({ status, data, url, header: n => (n === 'content-type' ? 'application/json' : null) });
    if (/hongguoduanju\.com/.test(url)) return reply(500, '');
    if (/device_register/.test(url)) {
      log.registrations++;
      if (failRegistration(log.registrations)) return reply(200, '{"code":0}');
      return reply(200, JSON.stringify({ device_id_str: '42000000000000000' + String(log.registrations).padStart(2, '0'), install_id_str: '4300000000000000001' }));
    }
    if (/api5-normal/.test(url)) {
      const device = new URL(url).searchParams.get('device_id');
      log.devices.push(device);
      if (emptyFor(device)) return reply(200, '');
      const vid = JSON.parse(new TextDecoder().decode(options.body)).mixed_video_id_map[1004][0];
      return reply(200, JSON.stringify({ code: 0, data: { [vid]: { video_model: { video_list: [
        { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
      ] } } } }));
    }
    return reply(404, '');
  });
  return log;
}

test('an empty playback answer renews the device once and retries with the new one', async () => {
  resetPlaybackDevice();
  const log = renewingTransport({ emptyFor: device => device === '4200000000000000001' });
  try {
    const info = await getPlayInfo('9000000000000000020', '', { force: true });
    assert.equal(info.url, MEDIA.main720);
    assert.equal(log.registrations, 2);
    assert.deepEqual(log.devices, ['4200000000000000001', '4200000000000000002']);
    await getPlayInfo('9000000000000000021', '', { force: true });
    assert.equal(log.registrations, 2, 'the renewed device is kept');
  } finally {
    resetPlaybackDevice();
  }
});

test('device renewal is shared, at most once a minute, and a failed one keeps the old device', async () => {
  resetPlaybackDevice();
  const log = renewingTransport({ emptyFor: () => true });
  const now = Date.now;
  try {
    await Promise.all(['9000000000000000022', '9000000000000000023'].map(vid =>
      assert.rejects(getPlayInfo(vid, '', { force: true }), /均未提供播放地址/)));
    assert.equal(log.registrations, 2, 'concurrent empty answers share one renewal');
    await assert.rejects(getPlayInfo('9000000000000000024', '', { force: true }));
    assert.equal(log.registrations, 2, 'no second renewal within a minute');
    const later = now() + 61000;
    Date.now = () => later;
    await assert.rejects(getPlayInfo('9000000000000000025', '', { force: true }));
    assert.equal(log.registrations, 3);
  } finally {
    Date.now = now;
    resetPlaybackDevice();
  }

  const failing = renewingTransport({ emptyFor: device => device === '4200000000000000001', failRegistration: n => n === 2 });
  await assert.rejects(getPlayInfo('9000000000000000026', '', { force: true }));
  assert.equal(failing.registrations, 2);
  await assert.rejects(getPlayInfo('9000000000000000027', '', { force: true }));
  assert.equal(failing.registrations, 2, 'the old device is kept, still within the minute');
  assert.deepEqual(failing.devices, ['4200000000000000001', '4200000000000000001']);
  resetPlaybackDevice();
});

test('a chosen quality with no compatible stream at all says so instead of blaming the quality', async () => {
  fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: {
    video_1: { codec_type: 'av1', definition: '1080p', main_url: 'https://v1.qznovelvod.com/av1.mp4', vwidth: 1080, vheight: 1920, spade_a: spadeFor(KEY) },
  } } } } });
  await assert.rejects(getPlayInfo('9000000000000000011', '', { force: true, quality: '1080p' }),
    err => /兼容的 H\.264\/HEVC.*设置/.test(err.message) && !/1080P/.test(err.message));
});
