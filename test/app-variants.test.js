// Offline: the App source's address list and the player's fallback along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, HttpError } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { resolvePlayback, setPlayMaxBytes } from '../src/media/playback.js';
import { resetPlaybackDevice } from '../src/sources/playback-device.js';
import { playbackRequest } from '../src/sources/app-source.js';
import { branchOf } from '../src/sources/app-signing.js';

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

// Upstream 5.5: one registered identity per playback lookup, since one may be single-use.
test('each app playback lookup registers its own anonymous device and sends it', async () => {
  resetPlaybackDevice();
  const requested = fake();
  await getPlayInfo('9000000000000000012', '', { force: true });
  await getPlayInfo('9000000000000000013', '', { force: true });
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 2);
  const calls = requested.filter(u => /api5-normal/.test(u)).map(u => new URL(u).searchParams);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(q => q.get('device_id') === REGISTERED.device_id_str && q.get('iid') === REGISTERED.install_id_str));
  assert.ok(calls.every(q => /^[0-9a-f-]{36}$/.test(q.get('cdid'))));
});

// Upstream 5.4: unsigned playback requests get empty bodies again.
test('playback requests are signed over the final query, body and timestamp', async () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const payload = '{"mixed_video_id_map":{"1004":["9000000000000000099"]}}';
  for (const host of ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-hl.fqnovel.com']) {
    const signed = playbackRequest(payload, identity, host);
    const url = new URL(signed.url);
    assert.equal(url.hostname, host);
    assert.equal(url.pathname, '/novel/player/multi_video_model/v1/');
    const khronos = Number(signed.headers['x-khronos']);
    assert.equal(url.searchParams.get('ts'), String(khronos));
    assert.equal(url.searchParams.get('_rticket'), signed.headers['x-ss-req-ticket']);
    assert.equal(url.searchParams.get('device_id'), identity.device_id);
    assert.equal(branchOf(signed.url, signed.body, khronos), 0, 'the request uses signature branch 0');
    assert.match(signed.headers['x-gorgon'], /^8404[0-9a-f]{4}4001[0-9a-f]{40}$/);
    assert.equal(Buffer.from(signed.headers['x-ladon'], 'base64').readUInt32BE(0), khronos);
    assert.equal(Buffer.from(signed.headers['x-argus'], 'base64').readUInt32LE(0), khronos);
    assert.ok(Buffer.from(signed.headers['x-helios'], 'base64').length >= 36);
    assert.ok(Buffer.from(signed.headers['x-medusa'], 'base64').length > 300);
    assert.equal(new TextDecoder().decode(signed.body), payload);
  }
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

// Upstream 5.5: an empty answer gets one more try on the alternate host, with a new device.
function renewingTransport({ emptyFor = () => false, failRegistration = () => false } = {}) {
  const log = { registrations: 0, devices: [], hosts: [] };
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
      log.hosts.push(new URL(url).hostname);
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

test('an empty playback answer retries once on the alternate host with a new device', async () => {
  resetPlaybackDevice();
  const log = renewingTransport({ emptyFor: device => device === '4200000000000000001' });
  try {
    const info = await getPlayInfo('9000000000000000020', '', { force: true });
    assert.equal(info.url, MEDIA.main720);
    assert.equal(log.registrations, 2);
    assert.deepEqual(log.devices, ['4200000000000000001', '4200000000000000002']);
    assert.deepEqual(log.hosts, ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-hl.fqnovel.com']);
  } finally {
    resetPlaybackDevice();
  }
});

test('a lookup tries at most two hosts, and keeps its device when re-registration fails', async () => {
  resetPlaybackDevice();
  const log = renewingTransport({ emptyFor: () => true });
  await assert.rejects(getPlayInfo('9000000000000000022', '', { force: true }), /均未提供播放地址/);
  assert.equal(log.devices.length, 2, 'one alternate-host attempt only');
  resetPlaybackDevice();

  const failing = renewingTransport({ emptyFor: device => device === '4200000000000000001', failRegistration: n => n === 2 });
  await assert.rejects(getPlayInfo('9000000000000000026', '', { force: true }), /均未提供播放地址/);
  assert.equal(failing.registrations, 2);
  assert.deepEqual(failing.devices, ['4200000000000000001', '4200000000000000001'], 'the alternate host still gets the first device');
  assert.deepEqual(failing.hosts, ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-hl.fqnovel.com']);
  resetPlaybackDevice();
});

// Upstream 5.5 (PR #92): inline streams with no encryption info may be read from fallback_api.
function inlineWithoutKeys(vid, fallbackData, model = {}) {
  const requested = fake({
    api: url => ({ status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: { [vid]: { video_model: Object.assign({
      video_id: 'v0abc', video_duration: 61.2, fallback_api: 'https://vas.snssdk.com/video/fallback',
      video_list: [{ codec_type: 'h264', definition: '1080p', main_url: MEDIA.main1080, vwidth: 1080, vheight: 1920 }],
    }, model) } } }) }),
    outer: { code: 0, video_info: { code: 0, data: fallbackData } },
  });
  return requested;
}

test('inline streams without encryption info are read from the checked fallback model', async () => {
  const fallbackStreams = {
    video_1: { codec_type: 'h264', definition: '1080p', main_url: MEDIA.backup1080, vwidth: 1080, vheight: 1920, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
    // Smaller than the inline stream: never offered.
    video_2: { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
  };
  const requested = inlineWithoutKeys('9000000000000000060', { video_id: 'v0abc', video_duration: 61.4, video_list: fallbackStreams });
  const info = await getPlayInfo('9000000000000000060', '', { force: true });
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.backup1080]);
  assert.equal(info.contentKey, KEY);
  assert.equal(requested.filter(u => /snssdk/.test(u)).length, 1);

  // Another video, another length, or a model that still hides its encryption: refused.
  for (const [vid, data] of [
    ['9000000000000000061', { video_id: 'v0other', video_duration: 61.2, video_list: fallbackStreams }],
    ['9000000000000000062', { video_id: 'v0abc', video_duration: 10, video_list: fallbackStreams }],
    ['9000000000000000063', { video_id: 'v0abc', video_duration: 61.2, video_list: { video_1: { codec_type: 'h264', definition: '1080p', main_url: MEDIA.backup1080, vwidth: 1080, vheight: 1920 } } }],
    ['9000000000000000064', { video_id: 'v0abc', video_duration: 61.2, video_list: { video_2: fallbackStreams.video_2 } }],
  ]) {
    inlineWithoutKeys(vid, data);
    await assert.rejects(getPlayInfo(vid, '', { force: true }), /均未提供播放地址/, vid);
  }
});

test('an inline stream that states an unusable encryption does not ask the fallback model', async () => {
  const requested = inlineWithoutKeys('9000000000000000065', { video_id: 'v0abc', video_duration: 61.2, video_list: videoList() }, {
    video_list: [{ codec_type: 'h264', definition: '1080p', main_url: MEDIA.main1080, vwidth: 1080, vheight: 1920, encrypt_info: { encrypt: true } }],
  });
  await assert.rejects(getPlayInfo('9000000000000000065', '', { force: true }), /均未提供播放地址/);
  assert.ok(!requested.some(u => /snssdk/.test(u)));
  const unsized = inlineWithoutKeys('9000000000000000066', { video_id: 'v0abc', video_duration: 61.2, video_list: videoList() }, {
    video_list: [{ codec_type: 'h264', definition: '1080p', main_url: MEDIA.main1080 }],
  });
  await assert.rejects(getPlayInfo('9000000000000000066', '', { force: true }), /均未提供播放地址/);
  assert.ok(!unsized.some(u => /snssdk/.test(u)), 'the inline size must be known to compare against');
});

test('a chosen quality with no compatible stream at all says so instead of blaming the quality', async () => {
  fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: {
    video_1: { codec_type: 'av1', definition: '1080p', main_url: 'https://v1.qznovelvod.com/av1.mp4', vwidth: 1080, vheight: 1920, spade_a: spadeFor(KEY) },
  } } } } });
  await assert.rejects(getPlayInfo('9000000000000000011', '', { force: true, quality: '1080p' }),
    err => /兼容的 H\.264\/HEVC.*设置/.test(err.message) && !/1080P/.test(err.message));
});

// Upstream 4.8: in auto quality the player swaps a stream the TV cannot decode for the next one.
test('a stream the TV could not decode is skipped with all its addresses', async () => {
  const requested = fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: sizedList() } } } });
  const info = await getPlayInfo('9000000000000000020', '', { force: true });
  assert.deepEqual(info.variants.map(v => v.stream), ['h264|1080p', 'hevc|1080', 'hevc|1080', 'hevc|720']);
  // Without the skip the unsized stream and the 1080P stream's two addresses fill all 3 attempts.
  await assert.rejects(resolvePlayback('9000000000000000020', '', {}), /HTTP 404/);
  await assert.rejects(resolvePlayback('9000000000000000020', '', { skip: ['h264|1080p'] }), /HTTP 404/);
  await assert.rejects(resolvePlayback('9000000000000000020', '', { skip: ['h264|1080p', 'hevc|1080'] }), /HTTP 404/);
  assert.deepEqual(requested.filter(u => /qznovelvod/.test(u)), [
    'https://v1.qznovelvod.com/unsized.mp4', MEDIA.main1080, MEDIA.backup1080,
    MEDIA.main1080, MEDIA.backup1080, MEDIA.main720,
    MEDIA.main720,
  ]);
});

test('with every stream skipped the player is told there is no other one', async () => {
  const requested = fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: sizedList() } } } });
  await assert.rejects(resolvePlayback('9000000000000000021', '', { force: true, skip: ['hevc|1080', 'h264|1080p', 'hevc|720'] }), err => {
    assert.equal(err.code, 'NO_OTHER_STREAM');
    assert.match(err.message, /无法解码/);
    return true;
  });
  assert.equal(requested.filter(u => /qznovelvod/.test(u)).length, 0);
});
