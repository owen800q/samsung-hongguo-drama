// Offline: the App source's address list and the player's fallback along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, HttpError } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { resolvePlayback, setPlayMaxBytes } from '../src/media/playback.js';
import { resetPlaybackDevice } from '../src/sources/playback-device.js';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { playbackRequest, fetchAppPlayUrl, setPlaybackPacing } from '../src/sources/app-source.js';
import { branchOf } from '../src/sources/app-signing.js';

const KEY = '0123456789abcdef0123456789abcdef';

// The one-second pause between lookups has its own test below.
setPlaybackPacing(0);

/** The episode a playback request asks for: video_tab names it in the query, the POST in its gzip body. */
function requestedVid(url, options) {
  return new URL(url).searchParams.get('video_id')
    || JSON.parse(zlib.gunzipSync(Buffer.from(options.body)).toString()).mixed_video_id_map[1004][0];
}

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
      if (api) return api(url, options);
      const vid = requestedVid(url, options);
      return reply(200, JSON.stringify({ code: 0, data: { video_model_data: { [vid]: { video_model: JSON.stringify({ fallback_api: 'https://vas.snssdk.com/video/fallback' }) } } } }));
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

// Upstream 5.4: unsigned playback requests get empty bodies again. 6.6: the POST body is
// gzipped and signed as sent. 6.7: the video_tab GET has no body.
test('playback requests are signed over the final query, the bytes sent and the timestamp', async () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const payload = '{"mixed_video_id_map":{"1004":["9000000000000000099"]}}';
  for (const videoId of ['9000000000000000099', '']) {
    const signed = playbackRequest(payload, identity, videoId);
    const url = new URL(signed.url);
    assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
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
    assert.equal(signed.headers['x-ss-dp'], '8662');
    if (videoId) {
      assert.equal(signed.method, 'GET');
      assert.equal(url.pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
      assert.equal(signed.body, null);
      assert.equal(url.searchParams.get('video_id'), videoId);
      assert.equal(url.searchParams.get('version_name'), '7.3.9.32');
      assert.equal(url.searchParams.get('from_video_id'), '');
      assert.equal(signed.headers['x-tt-request-tag'], 't=0;n=0');
      assert.ok(!('Content-Type' in signed.headers) && !('Content-Encoding' in signed.headers) && !('x-ss-stub' in signed.headers));
      assert.equal(signed.headers['passport-sdk-version'], '50561');
    } else {
      assert.equal(signed.method, 'POST');
      assert.equal(url.pathname, '/novel/player/multi_video_model/v1/');
      assert.equal(url.searchParams.get('version_name'), '7.4.3.32');
      assert.equal(url.searchParams.get('video_id'), null);
      assert.equal(zlib.gunzipSync(Buffer.from(signed.body)).toString(), payload);
      assert.equal(signed.headers['Content-Encoding'], 'gzip');
      assert.equal(signed.headers['x-ss-stub'], createHash('md5').update(signed.body).digest('hex').toUpperCase());
      assert.equal(signed.headers['passport-sdk-version'], '5051452');
    }
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
    await assert.rejects(getPlayInfo('9000000000000000017', '', { force: true }), error => /均未提供播放地址/.test(error.message) && error.appRejected === true);
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

// Upstream 5.5/6.9: an empty video_tab answer gets one try on the older POST, with a new device.
function renewingTransport({ emptyFor = () => false, failRegistration = () => false } = {}) {
  const log = { registrations: 0, devices: [], paths: [] };
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
      log.paths.push((options.method || 'GET') + ' ' + new URL(url).pathname);
      if (emptyFor(device)) return reply(200, '');
      const vid = requestedVid(url, options);
      const entry = { video_model: { video_list: [
        { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
      ] } };
      // Each endpoint answers in its own shape.
      return reply(200, JSON.stringify({ code: 0, data: options.method === 'POST' ? { [vid]: entry } : { video_model_data: { [vid]: entry } } }));
    }
    return reply(404, '');
  });
  return log;
}

test('an empty video_tab answer retries once on the older POST with a new device', async () => {
  resetPlaybackDevice();
  const log = renewingTransport({ emptyFor: device => device === '4200000000000000001' });
  try {
    const info = await getPlayInfo('9000000000000000020', '', { force: true });
    assert.equal(info.url, MEDIA.main720);
    assert.equal(log.registrations, 2);
    assert.deepEqual(log.devices, ['4200000000000000001', '4200000000000000002']);
    assert.deepEqual(log.paths, ['GET /reading/bookapi/video_tab/multi_video_model/v1/', 'POST /novel/player/multi_video_model/v1/']);
  } finally {
    resetPlaybackDevice();
  }
});

test('a lookup asks each endpoint at most once, and keeps its device when re-registration fails', async () => {
  resetPlaybackDevice();
  const log = renewingTransport({ emptyFor: () => true });
  await assert.rejects(getPlayInfo('9000000000000000022', '', { force: true }), /均未提供播放地址/);
  assert.equal(log.devices.length, 2, 'one attempt on the older endpoint only');
  resetPlaybackDevice();

  const failing = renewingTransport({ emptyFor: device => device === '4200000000000000001', failRegistration: n => n === 2 });
  await assert.rejects(getPlayInfo('9000000000000000026', '', { force: true }), /均未提供播放地址/);
  assert.equal(failing.registrations, 2);
  assert.deepEqual(failing.devices, ['4200000000000000001', '4200000000000000001'], 'the older endpoint still gets the first device');
  assert.deepEqual(failing.paths, ['GET /reading/bookapi/video_tab/multi_video_model/v1/', 'POST /novel/player/multi_video_model/v1/']);
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

// Upstream 5.8 (#102): a fallback model may state `encrypt: false` on the stream itself.
test('a fallback stream with a top-level plaintext flag plays without a key', async () => {
  let n = 70;
  for (const encrypt of [false, 0, '0', 'false']) {
    const vid = '90000000000000000' + (n++);
    inlineWithoutKeys(vid, { video_id: 'v0abc', video_duration: 61.2, video_list: {
      video_1: { codec_type: 'h264', definition: '1080p', main_url: MEDIA.backup1080, vwidth: 1080, vheight: 1920, encrypt, spade_a: '' },
    } });
    const info = await getPlayInfo(vid, '', { force: true });
    assert.equal(info.url, MEDIA.backup1080, JSON.stringify(encrypt));
    assert.equal(info.contentKey, null, JSON.stringify(encrypt));
  }
  for (const encrypt of [true, 1, '1', 'true']) {
    const vid = '90000000000000000' + (n++);
    inlineWithoutKeys(vid, { video_id: 'v0abc', video_duration: 61.2, video_list: {
      video_1: { codec_type: 'h264', definition: '1080p', main_url: MEDIA.backup1080, vwidth: 1080, vheight: 1920, encrypt, spade_a: '' },
    } });
    await assert.rejects(getPlayInfo(vid, '', { force: true }), /均未提供播放地址/, JSON.stringify(encrypt));
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

test('an episode offered only as ByteVC2 says the TV cannot play it, even at a chosen quality', async () => {
  const list = { video_1: { codec_type: 'bytevc2', definition: '1080p', main_url: MEDIA.main1080, vwidth: 1080, vheight: 1920, spade_a: spadeFor(KEY) } };
  fake({ outer: { code: 0, video_info: { code: 0, data: { video_list: list } } } });
  await assert.rejects(getPlayInfo('9000000000000000090', '', { force: true }),
    error => /ByteVC2/.test(error.message) && /官方 App/.test(error.message) && error.appRejected === true);
  await assert.rejects(getPlayInfo('9000000000000000090', '', { force: true, quality: '1080p' }), /ByteVC2/);
  // Any H.264/HEVC stream beside it still plays; ByteVC2 is never mistaken for HEVC.
  list.video_2 = { codec_type: 'bytevc1', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, spade_a: spadeFor(KEY) };
  const info = await getPlayInfo('9000000000000000091', '', { force: true });
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main720]);
});

test('an App refusal (HTTP 403/429) stops prefetch retries; a timeout does not', async () => {
  const { prefetch } = await import('../src/media/playback.js');
  for (const [status, outcome] of [[403, 'rejected'], [429, 'rejected'], [503, 'failed'], [0, 'failed']]) {
    fake({ api: () => { throw new HttpError(status ? 'HTTP ' + status : '请求超时', status); } });
    assert.equal(await prefetch('90000000000000001' + (status || '00'), '', null, 'auto'), outcome, String(status));
  }
});

// Upstream 6.7: video_tab nests the models and may list the streams as an object.
test('a video_tab answer is read from video_model_data, for the asked episode only', async () => {
  const stream = { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } };
  const answer = entries => ({ api: url => ({ status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: { video_model_data: entries } }) }) });
  let requested = fake(answer({ '9000000000000000201': { video_model: JSON.stringify({ video_list: { video_1: stream } }) } }));
  const info = await getPlayInfo('9000000000000000201', '', { force: true });
  assert.equal(info.url, MEDIA.main720);
  assert.equal(info.contentKey, KEY);
  const calls = requested.filter(u => /api5-normal/.test(u));
  assert.equal(calls.length, 1, 'an answered video_tab request is not followed by the older POST');
  assert.equal(new URL(calls[0]).searchParams.get('video_id'), '9000000000000000201');
  // Another episode's model, or a model that is not an object, is not played.
  requested = fake(answer({ '9000000000000000999': { video_model: { video_list: { video_1: stream } } } }));
  await assert.rejects(getPlayInfo('9000000000000000202', '', { force: true }), /均未提供播放地址/);
  fake(answer({ '9000000000000000203': { video_model: [stream] } }));
  await assert.rejects(getPlayInfo('9000000000000000203', '', { force: true }), /均未提供播放地址/);
});

// Upstream 6.9 (#138/#139): lookups take turns, a second apart.
test('app lookups run one at a time with a pause between them', async () => {
  const stream = { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } };
  const times = [];
  let active = 0;
  let overlap = false;
  fake({ api: async (url, options) => {
    times.push(Date.now());
    if (++active > 1) overlap = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    return { status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: { video_model_data: { [requestedVid(url, options)]: { video_model: { video_list: [stream] } } } } }) };
  } });
  setPlaybackPacing(200);
  try {
    const both = await Promise.all([fetchAppPlayUrl('9000000000000000301'), fetchAppPlayUrl('9000000000000000302')]);
    assert.deepEqual(both.map(info => info.url), [MEDIA.main720, MEDIA.main720]);
    assert.equal(overlap, false);
    assert.ok(times[1] - times[0] >= 220, 'the second lookup waited: ' + (times[1] - times[0]) + ' ms');
  } finally {
    setPlaybackPacing(0);
  }
});

test('an App refusal also fails the lookups waiting behind it; later ones ask again', async () => {
  let calls = 0;
  fake({ api: () => { calls++; throw new HttpError('HTTP 429', 429); } });
  const results = await Promise.all(['9000000000000000311', '9000000000000000312'].map(vid => fetchAppPlayUrl(vid).then(() => null, error => error)));
  assert.ok(results.every(error => error && error.rejected === true));
  assert.equal(calls, 1, 'the waiting lookup was not sent');
  await assert.rejects(fetchAppPlayUrl('9000000000000000313'));
  assert.equal(calls, 2);
  // A passing failure does not stop the queue.
  setPlaybackPacing(0);
  calls = 0;
  fake({ api: () => { calls++; throw new HttpError('HTTP 503', 503); } });
  await Promise.all(['9000000000000000314', '9000000000000000315'].map(vid => fetchAppPlayUrl(vid).catch(() => null)));
  assert.equal(calls, 2);
});
