// Offline: the App source's address list and the player's fallback along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTransport, HttpError } from '../src/lib/http.js';
import { getPlayInfo } from '../src/sources/index.js';
import { resolvePlayback, setPlayMaxBytes } from '../src/media/playback.js';
import { resetPlaybackDevice } from '../src/sources/playback-device.js';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { playbackRequest, playbackModelRequest, videoTabRequest, preloadRequest, fetchAppPlayUrl, setPlaybackPacing } from '../src/sources/app-source.js';
import { signPlayer } from '../src/sources/playback-signature.js';

const KEY = '0123456789abcdef0123456789abcdef';

// The one-second pause between lookups has its own test below.
setPlaybackPacing(0);

/** The episode a playback request asks for, from its gzip body (the video_tab GET: its query). */
function requestedVid(url, options) {
  if (!options.body) return new URL(url).searchParams.get('video_id');
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(options.body)).toString());
  return body.video_id || body.mixed_video_id_map[1004][0];
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
    if (/api5-normal|reading\.snssdk\.com/.test(url)) {
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

// Upstream 8.0: lookups share one registered identity (5.5 registered one per lookup).
test('app playback lookups share one anonymous device and send it', async () => {
  setPlaybackPacing(0);
  const requested = fake();
  await getPlayInfo('9000000000000000012', '', { force: true });
  await getPlayInfo('9000000000000000013', '', { force: true });
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 1);
  const calls = requested.filter(u => /api5-normal|reading\.snssdk\.com/.test(u)).map(u => new URL(u).searchParams);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(q => q.get('device_id') === REGISTERED.device_id_str && q.get('iid') === REGISTERED.install_id_str));
  assert.ok(/^[0-9a-f-]{36}$/.test(calls[0].get('cdid')) && calls[1].get('cdid') === calls[0].get('cdid'));
  setPlaybackPacing(0);
});

// Upstream 5.4: unsigned playback requests get empty bodies again. 6.6: the POST body is
// gzipped and signed as sent. 6.9: Argus/Ladon headers on the older POST. 7.5: the player
// endpoint carries v5 x-helios / x-medusa headers instead.
test('playback requests are signed over the final query, the bytes sent and the timestamp', async () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const payload = '{"mixed_video_id_map":{"1004":["9000000000000000099"]}}';
  for (const videoId of ['9000000000000000099', '']) {
    const signed = playbackRequest(payload, identity, videoId);
    const url = new URL(signed.url);
    assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
    const khronos = Number(signed.headers['x-khronos']);
    assert.equal(url.searchParams.get('device_id'), identity.device_id);
    assert.equal(url.searchParams.get('iid'), identity.iid);
    assert.equal(url.searchParams.get('cdid'), identity.cdid);
    assert.equal(signed.method, 'POST');
    assert.equal(zlib.gunzipSync(Buffer.from(signed.body)).toString(), payload);
    assert.equal(signed.headers['Content-Encoding'], 'gzip');
    assert.equal(signed.headers['x-ss-stub'].toLowerCase(), createHash('md5').update(signed.body).digest('hex'), 'MD5 of the gzip bytes sent, not of the JSON');
    assert.ok(!('x-gorgon' in signed.headers));
    if (videoId) {
      assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
      assert.deepEqual(Array.from(url.searchParams.keys()), ['aid', 'app_name', 'version_code', 'version_name', 'channel',
        'device_platform', 'device_type', 'os_version', 'update_version_code', 'iid', 'cdid', 'device_id', '_rticket']);
      assert.equal(url.searchParams.get('version_name'), '7.4.3.32');
      assert.equal(url.searchParams.get('channel'), 'vivo_8662_64');
      const ticket = Number(url.searchParams.get('_rticket'));
      assert.ok(ticket >= khronos * 1000 && ticket < khronos * 1000 + 2024, 'the ticket is searched from the signing time');
      assert.deepEqual(Object.keys(signed.headers).sort(), ['Accept', 'Content-Encoding', 'Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
      const prefix = Buffer.from(signed.headers['x-medusa'], 'base64').subarray(0, 4);
      assert.equal((prefix.readUInt32LE() ^ khronos) >>> 0, 5, 'a v5 envelope');
      const other = new URL(playbackRequest(payload, identity, videoId, true).url);
      assert.equal(other.hostname, 'api5-normal-sinfonlinea.fqnovel.com');
      assert.equal(other.pathname, url.pathname);
    } else {
      for (const name of ['x-medusa', 'x-helios']) assert.ok(!(name in signed.headers), name);
      assert.equal(url.searchParams.get('ts'), String(khronos));
      assert.equal(signed.headers['x-ss-req-ticket'], String(khronos * 1000));
      const ticket = Number(url.searchParams.get('_rticket'));
      assert.ok(ticket >= khronos * 1000 && ticket < khronos * 1000 + 1000);
      // Ladon starts with its four random bytes; Argus is checked by decoding nothing, only by
      // re-signing: the same query, body and time with another body or query must differ.
      const ladon = Buffer.from(signed.headers['x-ladon'], 'base64');
      assert.equal(ladon.length, 36);
      const again = signPlayer({ query: url.search.slice(1), body: signed.body, ts: khronos, randField: 1, ladonRandom: ladon.subarray(0, 4) });
      assert.equal(again['x-ladon'], signed.headers['x-ladon'], 'Ladon covers the aid in the final query and the time');
      assert.equal(again['x-ss-stub'], signed.headers['x-ss-stub']);
      assert.equal(Buffer.from(signed.headers['x-argus'], 'base64').length, Buffer.from(again['x-argus'], 'base64').length);
      assert.notEqual(again['x-argus'], signPlayer({ query: url.search.slice(1) + '&x=1', body: signed.body, ts: khronos, randField: 1, ladonRandom: ladon.subarray(0, 4) })['x-argus']);
      assert.equal(signed.headers['x-ss-dp'], '8662');
      assert.equal(url.pathname, '/novel/player/multi_video_model/v1/');
      assert.equal(url.searchParams.get('version_name'), '7.4.3.32');
      assert.equal(signed.headers['x-ss-stub'], createHash('md5').update(signed.body).digest('hex'));
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
  assert.ok(!requested.some(u => /vas\.snssdk/.test(u)));
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

// Upstream 7.7: the video_tab GET is signed like the player endpoint, over an empty body.
test('the video_tab request is a v5 GET without a body or body headers', () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const tab = videoTabRequest(identity, '9000000000000000099');
  const url = new URL(tab.url);
  assert.equal(tab.method, 'GET');
  assert.equal(tab.body, null);
  assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
  assert.equal(url.pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
  assert.deepEqual(Array.from(url.searchParams.keys()), ['aid', 'app_name', 'version_code', 'version_name', 'channel',
    'device_platform', 'device_type', 'os_version', 'update_version_code', 'iid', 'cdid', 'device_id', 'video_id', 'video_id_type',
    'device_level', 'need_all_video_definition', 'need_mp4_align', 'use_os_player', 'video_platform', 'source', 'from_video_id', '_rticket']);
  assert.equal(url.searchParams.get('video_id'), '9000000000000000099');
  assert.equal(url.searchParams.get('device_id'), identity.device_id);
  assert.equal(url.searchParams.get('from_video_id'), '');
  assert.deepEqual(Object.keys(tab.headers).sort(), ['Accept', 'x-helios', 'x-khronos', 'x-medusa']);
  const prefix = Buffer.from(tab.headers['x-medusa'], 'base64').subarray(0, 4);
  assert.equal((prefix.readUInt32LE() ^ Number(tab.headers['x-khronos'])) >>> 0, 5, 'a v5 envelope');
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

// Upstream 8.0/8.1: a lookup asks video_tab, the player endpoint on both hosts, the
// single-episode model endpoint on two more hosts, then the older POST, all with one device.
// Upstream 8.2: the current App's preload endpoint (host "reading") is asked before them.
const PRELOAD = 'POST /novel/player/multi_video_model/preload/v1';
const PLAYER = 'POST /novel/player/multi_video_model/player/v1';
const TAB = 'GET /reading/bookapi/video_tab/multi_video_model/v1/';
const MODEL = 'POST /novel/player/video_model/v1/';
const OLDER = 'POST /novel/player/multi_video_model/v1/';
const twice = list => list.reduce((all, item) => all.concat([item, item]), []);
const ROUND = twice([PRELOAD, TAB, PLAYER, PLAYER, MODEL, MODEL, OLDER]);
const ROUND_HOSTS = twice(['reading', 'b', 'b', 'a', 'a', 'c', 'b']);
function renewingTransport({ emptyFor = () => false, failRegistration = () => false, registrationReply } = {}) {
  const log = { registrations: 0, devices: [], paths: [], hosts: [] };
  setTransport(async (url, options) => {
    const reply = (status, data) => ({ status, data, url, header: n => (n === 'content-type' ? 'application/json' : null) });
    if (/hongguoduanju\.com/.test(url)) return reply(500, '');
    if (/device_register/.test(url)) {
      log.registrations++;
      const custom = registrationReply && registrationReply(log.registrations);
      if (custom) { if (custom.throw) throw custom.throw; return reply(custom.status, custom.data); }
      if (failRegistration(log.registrations)) return reply(200, '{"code":0}');
      return reply(200, JSON.stringify({ device_id_str: '42000000000000000' + String(log.registrations).padStart(2, '0'), install_id_str: '4300000000000000001' }));
    }
    if (/api5-normal|reading\.snssdk\.com/.test(url)) {
      const device = new URL(url).searchParams.get('device_id');
      log.devices.push(device);
      log.paths.push((options.method || 'GET') + ' ' + new URL(url).pathname);
      log.hosts.push(new URL(url).hostname.split('.')[0].replace(/^api5-normal-sinfonline/, ''));
      if (emptyFor(device)) return reply(200, '');
      const vid = requestedVid(url, options);
      const entry = { video_model: { video_list: [
        { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
      ] } };
      // Each endpoint answers in its own shape.
      return reply(200, JSON.stringify({ code: 0, data: /player\/v1$/.test(new URL(url).pathname) ? { 1004: { [vid]: entry } } : { [vid]: entry } }));
    }
    return reply(404, '');
  });
  return log;
}

test('an empty answer is asked once more, then on the next endpoint, all with the same device', async () => {
  setPlaybackPacing(0);
  // Everything before the older POST answers empty.
  const log = renewingTransport({ emptyFor: () => log.paths[log.paths.length - 1] !== OLDER });
  const info = await getPlayInfo('9000000000000000020', '', { force: true });
  assert.equal(info.url, MEDIA.main720);
  assert.equal(log.registrations, 1);
  assert.equal(new Set(log.devices).size, 1);
  assert.deepEqual(log.paths, ROUND.slice(0, 13));
  assert.deepEqual(log.hosts, ROUND_HOSTS.slice(0, 13));
  // An endpoint that answers on its second try ends the lookup there.
  setPlaybackPacing(0);
  const second = renewingTransport({ emptyFor: () => second.paths.length < 4 });
  assert.equal((await fetchAppPlayUrl('9000000000000000021')).url, MEDIA.main720);
  assert.deepEqual(second.paths, [PRELOAD, PRELOAD, TAB, TAB]);
  setPlaybackPacing(0);
});

test('a lookup answered empty everywhere is asked once more with a new device, at most every 30 s', async () => {
  setPlaybackPacing(0);
  const now = Date.now;
  const log = renewingTransport({ emptyFor: () => true });
  try {
    await assert.rejects(getPlayInfo('9000000000000000022', '', { force: true }), /均未提供播放地址/);
    assert.deepEqual(log.paths, ROUND.concat(ROUND));
    assert.equal(log.registrations, 2);
    assert.deepEqual(log.devices, new Array(14).fill('4200000000000000001').concat(new Array(14).fill('4200000000000000002')));
    // Within 30 s the next lookups keep that device: one round each, no new registration.
    await assert.rejects(fetchAppPlayUrl('9000000000000000023'), error => error.empty === true);
    await assert.rejects(fetchAppPlayUrl('9000000000000000024'), error => error.empty === true);
    assert.equal(log.registrations, 2);
    assert.equal(log.paths.length, 56);
    // After 30 s an empty lookup gets a new device again.
    const later = now() + 31000;
    Date.now = () => later;
    await assert.rejects(fetchAppPlayUrl('9000000000000000025'), error => error.empty === true);
    assert.equal(log.registrations, 3);
    assert.equal(log.devices[log.devices.length - 1], '4200000000000000003');
  } finally {
    Date.now = now;
    setPlaybackPacing(0);
  }
});

test('the new device answers after the first one got empty answers', async () => {
  setPlaybackPacing(0);
  const log = renewingTransport({ emptyFor: device => device === '4200000000000000001' });
  assert.equal((await fetchAppPlayUrl('9000000000000000026')).url, MEDIA.main720);
  assert.equal(log.registrations, 2);
  assert.deepEqual(log.paths, ROUND.concat([PRELOAD]));
  // The next lookup keeps the device that worked.
  assert.equal((await fetchAppPlayUrl('9000000000000000027')).url, MEDIA.main720);
  assert.equal(log.registrations, 2);
  setPlaybackPacing(0);
});

// Upstream 7.0: a refused registration ends the lookup and the ones queued behind it.
test('a refused registration of the new device stops the lookup and the ones queued behind it', async () => {
  const refusals = [{ status: 403, data: '' }, { status: 429, data: '' }, { status: 200, data: '{"code":1001}' }];
  for (const refusal of refusals) {
    setPlaybackPacing(0);
    const log = renewingTransport({ emptyFor: () => true, registrationReply: n => (n === 2 ? refusal : null) });
    const first = fetchAppPlayUrl('9000000000000000040').then(value => ({ value }), error => ({ error }));
    const queued = fetchAppPlayUrl('9000000000000000041').then(value => ({ value }), error => ({ error }));
    const failed = (await first).error;
    assert.ok(failed && failed.rejected === true, JSON.stringify(refusal));
    assert.match(failed.message, /设备注册被拒绝/);
    assert.equal((await queued).error, failed, 'the queued lookup fails with the same refusal');
    assert.equal(log.registrations, 2, 'nothing registers after the refusal');
    assert.deepEqual(log.paths, ROUND, 'nothing is asked without a device');
  }
  setPlaybackPacing(0);
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
  assert.equal(requested.filter(u => /vas\.snssdk/.test(u)).length, 1);

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
  assert.ok(!requested.some(u => /vas\.snssdk/.test(u)));
  const unsized = inlineWithoutKeys('9000000000000000066', { video_id: 'v0abc', video_duration: 61.2, video_list: videoList() }, {
    video_list: [{ codec_type: 'h264', definition: '1080p', main_url: MEDIA.main1080 }],
  });
  await assert.rejects(getPlayInfo('9000000000000000066', '', { force: true }), /均未提供播放地址/);
  assert.ok(!unsized.some(u => /vas\.snssdk/.test(u)), 'the inline size must be known to compare against');
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

// Upstream 7.5: the player endpoint nests the models under "1004"; 6.7: an answer may nest
// them under video_model_data and list the streams as an object.
test('a nested answer is read for the asked episode only', async () => {
  const stream = { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } };
  let nest = 'video_model_data';
  const answer = entries => ({ api: url => ({ status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: { [nest]: entries } }) }) });
  let requested = fake(answer({ '9000000000000000201': { video_model: JSON.stringify({ video_list: { video_1: stream } }) } }));
  const info = await getPlayInfo('9000000000000000201', '', { force: true });
  assert.equal(info.url, MEDIA.main720);
  assert.equal(info.contentKey, KEY);
  const calls = requested.filter(u => /api5-normal|reading\.snssdk\.com/.test(u));
  assert.equal(calls.length, 1, 'an answered request is not followed by another endpoint');
  assert.equal(new URL(calls[0]).pathname, '/novel/player/multi_video_model/preload/v1');
  nest = '1004';
  fake(answer({ '9000000000000000204': { video_model: { video_list: [stream] } } }));
  assert.equal((await getPlayInfo('9000000000000000204', '', { force: true })).url, MEDIA.main720);
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

// Upstream 8.0: the single-episode model endpoint, signed and sent like the player endpoint.
test('the single-episode model request is a signed gzip POST for that episode', () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const base = 'https://api5-normal-sinfonlinec.fqnovel.com/novel/player/video_model/v1/';
  const signed = playbackModelRequest(identity, '9000000000000000099', base);
  const url = new URL(signed.url);
  assert.equal(signed.method, 'POST');
  assert.equal(url.origin + url.pathname, base);
  assert.deepEqual(Array.from(url.searchParams.keys()), ['aid', 'app_name', 'version_code', 'version_name', 'channel',
    'device_platform', 'device_type', 'os_version', 'update_version_code', 'iid', 'cdid', 'device_id', '_rticket']);
  assert.equal(url.searchParams.get('device_id'), identity.device_id);
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(signed.body)).toString());
  assert.equal(body.video_id, '9000000000000000099');
  assert.equal(body.content_type, 1004);
  assert.deepEqual(body.biz_param, { detail_page_version: 0, device_level: 3, disable_digg_stat: false, from_video_id: '',
    need_all_video_definition: true, need_mp4_align: false, source: 9, use_os_player: false, use_server_dns: false, video_platform: 3 });
  assert.deepEqual(Object.keys(signed.headers).sort(), ['Accept', 'Content-Encoding', 'Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
  assert.equal(signed.headers['x-ss-stub'].toLowerCase(), createHash('md5').update(signed.body).digest('hex'));
  const prefix = Buffer.from(signed.headers['x-medusa'], 'base64').subarray(0, 4);
  assert.equal((prefix.readUInt32LE() ^ Number(signed.headers['x-khronos'])) >>> 0, 5, 'a v5 envelope');
});

// Upstream 7.7/8.0: business code 110001 is about this anonymous device, so the lookup is
// asked once more with a new one and nothing queued is stopped. 8.0: a timeout is not asked
// again within the lookup.
test('business code 110001 asks once more with a new device; a timeout and other refusals do not', async () => {
  const stream = { codec_type: 'h264', definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } };
  const ok = (url, options) => ({ status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: { 1004: { [requestedVid(url, options)]: { video_model: { video_list: [stream] } } } } }) });
  setPlaybackPacing(0);
  let calls = 0;
  let requested = fake({ api: (url, options) => (++calls === 1 ? { status: 200, url, header: () => null, data: '{"code":110001}' } : ok(url, options)) });
  assert.equal((await fetchAppPlayUrl('9000000000000000411')).url, MEDIA.main720);
  assert.equal(calls, 2);
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 2);
  // Always turned away: one more try per lookup, each with a new device, and the lookup
  // behind it is still sent with yet another one.
  setPlaybackPacing(0);
  calls = 0;
  requested = fake({ api: url => { calls++; return { status: 200, url, header: () => null, data: '{"code":110001}' }; } });
  const results = await Promise.all(['9000000000000000412', '9000000000000000413'].map(vid => fetchAppPlayUrl(vid).then(() => null, error => error)));
  assert.ok(results.every(error => error && error.rejected === false && error.businessCode === 110001));
  assert.equal(calls, 4);
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 4);
  // A timeout ends the lookup; the device is kept.
  setPlaybackPacing(0);
  calls = 0;
  requested = fake({ api: () => { calls++; throw Object.assign(new HttpError('请求超时', 0), { timeout: true }); } });
  await assert.rejects(fetchAppPlayUrl('9000000000000000417'), error => error.timedOut === true);
  assert.equal(calls, 1);
  assert.equal(requested.filter(u => /device_register/.test(u)).length, 1);
  setPlaybackPacing(0);
  // Any other business code is a refusal: one request, and the queue stops.
  calls = 0;
  fake({ api: url => { calls++; return { status: 200, url, header: () => null, data: '{"code":1001}' }; } });
  const refused = await Promise.all(['9000000000000000414', '9000000000000000415'].map(vid => fetchAppPlayUrl(vid).then(() => null, error => error)));
  assert.ok(refused.every(error => error && error.rejected === true));
  assert.equal(calls, 1);
  // A lost connection (no timeout) is the TV's network: not asked again.
  setPlaybackPacing(0);
  calls = 0;
  fake({ api: () => { calls++; throw new HttpError('网络连接失败', 0); } });
  await assert.rejects(fetchAppPlayUrl('9000000000000000416'), error => error.network === true);
  assert.equal(calls, 1);
  setPlaybackPacing(0);
});

// Upstream 8.2: the current App's preload request, asked before the other endpoints.
test('the preload request is a signed gzip POST for that episode with its own profile', () => {
  const identity = { device_id: REGISTERED.device_id_str, iid: REGISTERED.install_id_str, cdid: '00000000-0000-4000-8000-000000000000' };
  const signed = preloadRequest(identity, '9000000000000000099');
  const url = new URL(signed.url);
  assert.equal(signed.method, 'POST');
  assert.equal(url.origin + url.pathname, 'https://reading.snssdk.com/novel/player/multi_video_model/preload/v1');
  assert.deepEqual(Array.from(url.searchParams.keys()), ['aid', 'app_name', 'version_code', 'version_name', 'update_version_code',
    'manifest_version_code', 'os', 'ssmix', 'channel', 'device_platform', 'device_type', 'device_brand', 'os_version', 'os_api',
    'ac', 'language', 'host_abi', 'iid', 'cdid', 'device_id', '_rticket']);
  assert.equal(url.searchParams.get('version_code'), '74532');
  assert.equal(url.searchParams.get('device_id'), identity.device_id);
  assert.equal(url.searchParams.get('iid'), identity.iid);
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(signed.body)).toString());
  assert.equal(body.dr_scene, 'preload');
  assert.equal(body.biz_param.device_level, 2);
  assert.deepEqual(body.mixed_video_id_map, { 1004: ['9000000000000000099'] });
  assert.deepEqual(Object.keys(signed.headers).sort(), ['Accept', 'Content-Encoding', 'Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
  assert.equal(signed.headers['x-ss-stub'].toLowerCase(), createHash('md5').update(signed.body).digest('hex'));
  const prefix = Buffer.from(signed.headers['x-medusa'], 'base64').subarray(0, 4);
  assert.equal((prefix.readUInt32LE() ^ Number(signed.headers['x-khronos'])) >>> 0, 5, 'a v5 envelope');
});

// Upstream 8.2: the endpoint that last gave a usable model is asked first by later lookups.
test('the endpoint that answered is asked first from then on', async () => {
  setPlaybackPacing(0);
  // Only the player endpoint answers.
  const log = renewingTransport({ emptyFor: () => log.paths[log.paths.length - 1] !== PLAYER });
  assert.equal((await fetchAppPlayUrl('9000000000000000501')).url, MEDIA.main720);
  assert.deepEqual(log.paths, [PRELOAD, PRELOAD, TAB, TAB, PLAYER]);
  assert.equal((await fetchAppPlayUrl('9000000000000000502')).url, MEDIA.main720);
  assert.deepEqual(log.paths.slice(5), [PLAYER]);
  assert.equal(log.registrations, 1);
  // When it stops answering, the others are asked in their usual order after it.
  const later = renewingTransport({ emptyFor: () => later.paths[later.paths.length - 1] !== TAB });
  assert.equal((await fetchAppPlayUrl('9000000000000000503')).url, MEDIA.main720);
  assert.deepEqual(later.paths, [PLAYER, PLAYER, PRELOAD, PRELOAD, TAB]);
  assert.deepEqual(later.hosts, ['b', 'b', 'reading', 'reading', 'b']);
  // An answer without a usable model does not move its endpoint to the front.
  setPlaybackPacing(0);
  fake({ api: url => ({ status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: {} }) }) });
  await assert.rejects(fetchAppPlayUrl('9000000000000000504'), /未返回所选分集/);
  const fresh = renewingTransport();
  assert.equal((await fetchAppPlayUrl('9000000000000000505')).url, MEDIA.main720);
  assert.deepEqual(fresh.paths, [PRELOAD]);
  setPlaybackPacing(0);
});

// Upstream 8.2: an inline model with no stream the TV can use is asked again through its
// fallback_api, for HEVC (codec_type=1) and then H.264 (codec_type=0&force_codec=h264).
test('an inline model without a usable stream asks the fallback model for another codec', async () => {
  const good = { codec_type: 'h264', definition: '1080p', main_url: MEDIA.main1080, vwidth: 1080, vheight: 1920, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } };
  const inline = (vid, list, extra = {}) => ({ status: 200, header: () => null, data: JSON.stringify({ code: 0, data: { 1004: { [vid]: { video_model: Object.assign({
    video_id: 'v0abc', video_duration: 61.2, fallback_api: 'https://vas.snssdk.com/video/fallback?a=1', video_list: list }, extra) } } } }) });
  const run = async (vid, list, answer, options = {}, extra) => {
    setPlaybackPacing(0);
    const asked = [];
    setTransport(async url => {
      const reply = (status, data) => ({ status, data, url, header: n => (n === 'content-type' ? 'application/json' : null) });
      if (/device_register/.test(url)) return reply(200, JSON.stringify(REGISTERED));
      if (/vas\.snssdk\.com/.test(url)) { asked.push(new URL(url).search); return answer(new URL(url).searchParams, reply); }
      if (/api5-normal|reading\.snssdk\.com/.test(url)) return Object.assign(inline(vid, list, extra), { url });
      return reply(404, '');
    });
    return { asked, result: await fetchAppPlayUrl(vid, options).then(value => ({ value }), error => ({ error })) };
  };
  const model = list => JSON.stringify({ code: 0, video_info: { code: 0, data: { video_id: 'v0abc', video_duration: 61.3, video_list: list } } });
  const byteVc2 = [{ codec_type: 'bytevc2', definition: '1080p', main_url: MEDIA.main1080, vwidth: 1080, vheight: 1920, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } }];

  // The HEVC ask answers: one fallback request, with the address's own query kept.
  let { asked, result } = await run('9000000000000000601', byteVc2, (q, reply) => reply(200, model([good])));
  assert.equal(result.value.url, MEDIA.main1080);
  assert.equal(result.value.contentKey, KEY);
  assert.deepEqual(asked, ['?a=1&codec_type=1']);
  // HEVC gives nothing usable: H.264 is asked next.
  ({ asked, result } = await run('9000000000000000602', byteVc2, (q, reply) => reply(200, model(q.get('force_codec') === 'h264' ? [good] : byteVc2))));
  assert.equal(result.value.url, MEDIA.main1080);
  assert.deepEqual(asked, ['?a=1&codec_type=1', '?a=1&codec_type=0&force_codec=h264']);
  // Neither helps, or the fallback is another video: the first error is reported.
  ({ asked, result } = await run('9000000000000000603', byteVc2, (q, reply) => reply(200, model(byteVc2))));
  assert.equal(result.error.code, 'UNSUPPORTED_CODEC');
  assert.equal(asked.length, 2);
  ({ result } = await run('9000000000000000604', byteVc2, (q, reply) => reply(200, JSON.stringify({ code: 0, video_info: { code: 0, data: { video_id: 'v0other', video_duration: 61.2, video_list: [good] } } }))));
  assert.equal(result.error.code, 'UNSUPPORTED_CODEC');
  ({ result } = await run('9000000000000000605', byteVc2, (q, reply) => reply(200, '{"code":1}')));
  assert.equal(result.error.code, 'UNSUPPORTED_CODEC');
  assert.ok(!result.error.rejected, 'a fallback that refuses a codec is not the App refusing the TV');
  // A chosen quality the inline model lacks is looked for in the fallback model too, and is
  // still never downgraded.
  const only720 = [Object.assign({}, good, { definition: '720p', main_url: MEDIA.main720, vwidth: 720, vheight: 1280 })];
  ({ result } = await run('9000000000000000606', only720, (q, reply) => reply(200, model([good])), { quality: '1080p' }));
  assert.equal(result.value.url, MEDIA.main1080);
  ({ asked, result } = await run('9000000000000000607', only720, (q, reply) => reply(200, model(only720)), { quality: '1080p' }));
  assert.equal(result.error.code, 'QUALITY_UNAVAILABLE');
  assert.equal(asked.length, 2);
  // An HTTP refusal while asking is reported as such.
  ({ asked, result } = await run('9000000000000000608', byteVc2, () => { throw new HttpError('HTTP 403', 403); }));
  assert.equal(result.error.status, 403);
  assert.equal(asked.length, 1);
  // Without a video id and length to compare against, the fallback model is not asked.
  ({ asked, result } = await run('9000000000000000609', byteVc2, (q, reply) => reply(200, model([good])), {}, { video_id: '' }));
  assert.equal(result.error.code, 'UNSUPPORTED_CODEC');
  assert.equal(asked.length, 0);
  setPlaybackPacing(0);
});

// Upstream 8.2: a stream's `backup_url_1` is one of its addresses.
test('backup_url_1 is used when the main address is not a media address', async () => {
  setPlaybackPacing(0);
  fake({ api: url => ({ status: 200, url, header: () => null, data: JSON.stringify({ code: 0, data: { 1004: { '9000000000000000701': { video_model: { video_list: [
    { codec_type: 'h264', definition: '720p', main_url: 'https://127.0.0.1/private', backup_url_1: MEDIA.main720, vwidth: 720, vheight: 1280, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
    { codec_type: 'h264', definition: '1080p', backup_url_1: MEDIA.main1080, vwidth: 1080, vheight: 1920, encrypt_info: { spade_a: spadeFor(KEY), encrypt: true } },
  ] } } } } }) }) });
  const info = await fetchAppPlayUrl('9000000000000000701');
  assert.deepEqual(info.variants.map(v => v.url), [MEDIA.main1080, MEDIA.main720]);
  setPlaybackPacing(0);
});
