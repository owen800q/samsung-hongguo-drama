// SPDX-License-Identifier: GPL-3.0-only
// Spade algorithms adapted from woshishiq1/drpys
// commit 22261adfa31435e3b3ef5a730b8a2a75bcaf1715, spider/js/红果果[短].js,
// via N3urda/hongguoTV eea73e6a45569a2cbbb9440f7cd5290c459b0b70, and the desktop
// hongguo-drama app. TV changes: Uint8Array instead of Buffer, pure JS hashes, and no
// User-Agent header (browsers cannot set it). Playback uses a registered anonymous
// device (playback-device.js, upstream 3.9/5.5) and signed requests (playback-signature.js:
// upstream 6.9 replaced the Gorgon/Medusa/Helios headers with real Argus/Ladon ones).
// Upstream 7.5: the player endpoint, signed with v5 x-helios / x-medusa headers
// (playback-v5.js), is asked first, then the same request on the other official host, and
// the older Argus/Ladon POST only after empty answers. Upstream 7.7: the video_tab GET
// belongs to the player family too, signed with v5 headers and no body.
// Upstream 8.0/8.1: one anonymous device is kept across lookups, and a lookup asks
// video_tab, the player endpoint on both hosts, the single-episode model endpoint on two
// more hosts and the older POST in turn, each once more after an empty answer. The device
// is replaced within a lookup, once, after business code 110001 (see fetchAppPlayUrl).
// Upstream 8.3: after empty answers the lookup ends without a second round; the device is
// replaced for later lookups once two have ended that way and 30 s have passed.
// Upstream 8.2: the current App's preload endpoint is asked before all of those, the endpoint
// that last gave a usable model is asked first from then on, and a model whose listed streams
// the TV cannot use is asked again through its fallback_api for an HEVC or H.264 one.
// Lookups take turns, one second apart (upstream 6.9).
// Upstream 8.5: the App's video_detail endpoint lists every episode of a series
// (fetchAppEpisodeList), since the website only lists the few it shows publicly.
// SDK protocol constants below are not user credentials.
import { request } from '../lib/http.js';
import { getPlaybackDevice, resetPlaybackDevice } from './playback-device.js';
import { signPlayer } from './playback-signature.js';
import { signPlaybackV5 } from './playback-v5.js';
import { sha512, aes128CbcDecrypt } from '../lib/crypto.js';
import { utf8, fromUtf8, fromHex, fromBase64, concat, gzipStored } from '../lib/bytes.js';

const VIDEO_API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/';
const PLAYER_API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1';
const VIDEO_TAB_API = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/';
// Upstream 8.2: the current App's preload endpoint, asked first.
const PRELOAD_API = 'https://reading.snssdk.com/novel/player/multi_video_model/preload/v1';
// Upstream 8.5: a series' full episode list.
const VIDEO_DETAIL_API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_detail/v1/';
// Upstream 8.0: the single-episode model endpoint, on two further official hosts.
const MODEL_APIS = [
  'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/',
  'https://api5-normal-sinfonlinec.fqnovel.com/novel/player/video_model/v1/',
];
const DEVICE = {
  ac: 'wifi', channel: 'update_64', aid: '8662', app_name: 'novelread',
  version_code: '71332', version_name: '7.1.3.32', device_platform: 'android', os: 'android',
  ssmix: 'a', device_type: '25053RT47C', device_brand: 'Redmi', language: 'zh', os_api: '36',
  os_version: '16', manifest_version_code: '71332', resolution: '1280*2772', dpi: '520',
  update_version_code: '71332', host_abi: 'arm64-v8a', dragon_device_type: 'phone', pv_player: '71332',
  compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0',
};
function appVersion(code, name) {
  return Object.assign({}, DEVICE, { version_code: code, version_name: name, manifest_version_code: code, update_version_code: code, pv_player: code });
}
// Upstream 6.6: the older POST is asked as the App version it was observed with.
const PLAYBACK_DEVICE = appVersion('74332', '7.4.3.32');
// Upstream 7.5: the profile the v5 signature was observed with; it is also written into the
// signed message, so the query and the signature have to agree on it.
const PLAYER_PROFILE = {
  aid: '8662', app_name: 'novelread', version_code: '74332', version_name: '7.4.3.32', channel: 'vivo_8662_64',
  device_platform: 'android', device_type: 'PGT-AN10', os_version: '12', update_version_code: '74332',
};
// Upstream 8.2: the profile the preload request was observed with, in query order.
const PRELOAD_PROFILE = {
  aid: '8662', app_name: 'novelread', version_code: '74532', version_name: '7.4.5.32',
  update_version_code: '74532', manifest_version_code: '74532', os: 'android', ssmix: 'a',
  channel: 'update_64', device_platform: 'android', device_type: '25053RT47C',
  device_brand: 'Redmi', os_version: '16', os_api: '36', ac: 'wifi', language: 'zh',
  host_abi: 'arm64-v8a',
};

function str(value, fallback = '') { return String(value == null ? fallback : value).trim(); }
function cleanUrl(value) { return str(value).replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&'); }
function jsonBody(value) { try { return JSON.parse(value); } catch (_) { return null; } }
// Match Python's urllib quoting of !'(), as the desktop app does.
function pythonUrlEncode(values) {
  return Object.keys(values).map(key => {
    const encode = item => encodeURIComponent(String(item == null ? '' : item))
      .replace(/[!'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
    return encode(key) + '=' + encode(values[key]);
  }).join('&');
}
// Unsigned playback requests get HTTP 200 with an empty body (upstream 5.4), and so do ones
// signed the way an earlier App version did. Every signature covers the final query, the
// bytes actually sent and the timestamp, so it is rebuilt for every attempt. The JSON body
// is always sent gzipped (upstream 6.6). With `videoId` this is the player endpoint with v5
// headers (upstream 7.5), on the other official host when `alternate`; without it, the older
// POST with Argus/Ladon headers (upstream 6.9).
export function playbackRequest(payload, identity, videoId, alternate) {
  const body = gzipStored(utf8(payload));
  if (videoId) {
    const signed = signPlaybackV5({
      base: alternate ? PLAYER_API.replace('sinfonlineb.', 'sinfonlinea.') : PLAYER_API,
      values: Object.assign({}, PLAYER_PROFILE, { iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id }),
      body, now: Date.now(),
    });
    return {
      url: signed.url, body, method: 'POST',
      headers: Object.assign({}, signed.headers, { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' }),
    };
  }
  const ticket = Date.now();
  const khronos = Math.floor(ticket / 1000);
  const device = Object.assign({}, PLAYBACK_DEVICE, identity);
  const query = pythonUrlEncode(Object.assign({}, device, { ts: String(khronos), _rticket: String(ticket) }));
  const signature = signPlayer({ query, body, ts: khronos });
  const headers = {
    Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'x-ss-req-ticket': signature['x-ss-req-ticket'], 'sdk-version': '2', 'x-xs-from-web': '0',
    'passport-sdk-version': '5051452', 'x-ss-dp': String(device.aid),
    'x-khronos': signature['x-khronos'], 'x-ladon': signature['x-ladon'], 'x-argus': signature['x-argus'],
    'x-tt-dt': '', 'x-tt-store-region': 'cn', 'x-tt-store-region-src': 'did',
    'Content-Type': 'application/json; charset=UTF-8', 'Content-Encoding': 'gzip', 'x-ss-stub': signature['x-ss-stub'],
  };
  return { url: VIDEO_API + '?' + query, body, headers, method: 'POST' };
}
// Upstream 8.0: one episode's model from the single-episode endpoint at `base`, signed and
// sent like the player endpoint.
export function playbackModelRequest(identity, videoId, base) {
  const body = gzipStored(utf8(JSON.stringify({
    biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, from_video_id: '',
      need_all_video_definition: true, need_mp4_align: false, source: 9, use_os_player: false,
      use_server_dns: false, video_platform: 3 },
    content_type: 1004,
    video_id: String(videoId),
  })));
  const signed = signPlaybackV5({
    base,
    values: Object.assign({}, PLAYER_PROFILE, { iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id }),
    body, now: Date.now(),
  });
  return {
    url: signed.url, body, method: 'POST',
    headers: Object.assign({}, signed.headers, { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' }),
  };
}
// Upstream 8.2: the current App's preload request for one episode: a v5-signed gzip POST like
// the player endpoint, with its own profile, device_level 2 and a different field 21 in the
// signed message.
export function preloadRequest(identity, videoId) {
  const body = gzipStored(utf8(JSON.stringify({
    biz_param: { detail_page_version: 0, device_level: 2, disable_digg_stat: false,
      disable_video_relate_book: false, need_all_video_definition: true, need_mp4_align: false,
      use_os_player: false, use_server_dns: false, video_platform: 1024 },
    mixed_video_id_map: { 1004: [String(videoId)] },
    dr_scene: 'preload',
  })));
  const signed = signPlaybackV5({
    base: PRELOAD_API,
    values: Object.assign({}, PRELOAD_PROFILE, { iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id }),
    body, now: Date.now(), field21: 312,
  });
  return {
    url: signed.url, body, method: 'POST',
    headers: Object.assign({}, signed.headers, { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' }),
  };
}
// Upstream 8.5: the App's detail request for one series, signed and sent like the preload request.
export function videoDetailRequest(identity, seriesId) {
  const body = gzipStored(utf8(JSON.stringify({
    series_id: String(seriesId),
    biz_param: { caller_scene: 'single_col', detail_page_version: 0, from_video_id: '',
      need_all_video_definition: false, need_mp4_align: false, source: 4, video_id_type: 1 },
  })));
  const signed = signPlaybackV5({
    base: VIDEO_DETAIL_API,
    values: Object.assign({}, PRELOAD_PROFILE, { iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id }),
    body, now: Date.now(), field21: 312,
  });
  return {
    url: signed.url, body, method: 'POST',
    headers: Object.assign({}, signed.headers, { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' }),
  };
}
// Upstream 7.7: the video_tab GET for one episode. Signed like the player endpoint, with
// the digest of an empty body and none of the headers that describe a body; the older
// Argus/Ladon headers get an empty answer here.
export function videoTabRequest(identity, videoId) {
  const signed = signPlaybackV5({
    base: VIDEO_TAB_API,
    values: Object.assign({}, PLAYER_PROFILE, {
      iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id,
      video_id: String(videoId), video_id_type: '0', device_level: '1', need_all_video_definition: '1',
      need_mp4_align: '0', use_os_player: '0', video_platform: '1024', source: '0', from_video_id: '',
    }),
    body: null, now: Date.now(),
  });
  return { url: signed.url, body: null, method: 'GET', headers: Object.assign({}, signed.headers, { Accept: 'application/json' }) };
}
function parseFallback(value) {
  if (typeof value === 'string') { const parsed = jsonBody(value); return (parsed && parsed.fallback_api) || value; }
  if (Array.isArray(value)) return str(value[0]);
  return str(value && value.fallback_api);
}
function deriveContentKey(value) {
  const raw = fromBase64(str(value).replace(/-/g, '+').replace(/_/g, '/'));
  if (raw.length < 3) throw new Error('spade_a too short');
  let v8 = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
  v8 = Math.min(v8, raw.length - 1);
  if (v8 < 33) throw new Error('spade_a key length invalid');
  const work = raw.slice(1, 1 + v8); let a = 85; let b = 246;
  for (let i = 0; i < v8; i += 1) {
    const old = work[i]; const previous = i & 1 ? a : b;
    if (i & 1) a = old; else b = old;
    const pop = i.toString(2).split('1').length - 1;
    work[i] = (-21 - pop + (previous ^ old)) & 255;
  }
  let hex = '';
  for (let i = 1; i < 33; i++) hex += String.fromCharCode(work[i]);
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('App 视频密钥格式无效');
  return hex.toLowerCase();
}
function decryptSpadeUrl(value, seed) {
  const encoded = str(value); if (!encoded) return '';
  const raw = fromBase64(encoded);
  if (raw.length < 5) throw new Error('spade URL ciphertext too short');
  if (raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00) throw new Error('spade URL header format error');
  const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
  if (!cipherLength) throw new Error('spade URL ciphertext has no complete block');
  const constants = fromHex('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58');
  const h1 = sha512(seed); const h2 = sha512(concat([h1, constants]));
  let plaintext = aes128CbcDecrypt(h2.subarray(0, 16), h2.subarray(16, 32), raw.subarray(4, 4 + cipherLength));
  if (plaintext.length) {
    const padding = plaintext[plaintext.length - 1];
    if (padding >= 1 && padding <= 16 && padding <= plaintext.length) plaintext = plaintext.subarray(0, plaintext.length - padding);
  }
  let end = plaintext.length;
  while (end && plaintext[end - 1] === 0) end--;
  return fromUtf8(plaintext.subarray(0, end));
}
function checkedUrl(value, domains) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('App 片源地址格式无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !domains.some(domain => url.hostname === domain || url.hostname.slice(-(domain.length + 1)) === '.' + domain)) {
    throw new Error('App 片源返回了不受支持的服务地址');
  }
  return url.href;
}
/** Series and episode ids exceed 2^53: quote them before JSON.parse rounds them (upstream 8.5). */
export function preserveLargeJsonIntegers(raw, fields) {
  return raw.replace(new RegExp('("(?:' + fields.join('|') + ')"\\s*:\\s*)(-?\\d{16,})(?=\\s*[,}\\]])', 'g'), '$1"$2"');
}
async function requestJson(url, options, deadline, preserve) {
  url = checkedUrl(url, ['fqnovel.com', 'snssdk.com']);
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw Object.assign(new Error('App 片源请求超时'), { network: true, timedOut: true });
  let res;
  try {
    res = await request(url, Object.assign({}, options, { responseType: 'text', timeout }));
  } catch (error) {
    // Upstream 5.7: 403/429 is the App refusing this TV, not a passing outage.
    if (error && error.status > 0) throw Object.assign(new Error('App 片源请求失败（HTTP ' + error.status + '）'), { status: error.status, rejected: error.status === 403 || error.status === 429 });
    // No response at all: the TV's connection, not the source, is the likely cause.
    throw Object.assign(new Error('App 片源请求失败，请稍后重试'), { network: true, timedOut: !!(error && error.timeout) });
  }
  // XHR follows redirects itself; make sure we still ended on an allowed host.
  if (res.url) checkedUrl(res.url, ['fqnovel.com', 'snssdk.com']);
  if (typeof res.data === 'string' && !res.data.trim()) throw Object.assign(new Error('App 接口返回空响应（HTTP 200），原因尚未确认'), { empty: true });
  const parsed = typeof res.data === 'string' ? jsonBody(preserve ? preserveLargeJsonIntegers(res.data, preserve) : res.data) : res.data;
  if (!parsed || typeof parsed !== 'object') throw new Error('App 接口未返回有效数据');
  return parsed;
}

/** Short edge of a stream in pixels, or 0 when the source gives no usable size. */
function shortEdge(item) {
  const meta = item.video_meta || {};
  const pairs = [[item.vwidth, item.vheight], [item.width, item.height], [meta.vwidth, meta.vheight], [meta.width, meta.height]];
  for (let i = 0; i < pairs.length; i++) {
    const w = Number(pairs[i][0]); const h = Number(pairs[i][1]);
    if (isFinite(w) && isFinite(h) && w > 0 && h > 0) return Math.min(w, h);
  }
  return 0;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
// Upstream 7.7: business code 110001 is the App turning this anonymous device away, not the
// episode: it does not stop other lookups, and the lookup is asked again with a new device.
const DEVICE_TURNED_AWAY = 110001;
function businessRejected(code) {
  const businessCode = Number(code) || 0;
  return Object.assign(new Error('App 接口暂未提供本集播放信息'), { rejected: businessCode !== DEVICE_TURNED_AWAY, businessCode });
}
// Upstream 8.0: an empty answer is asked once more after this pause before the next endpoint.
const EMPTY_RETRY_MS = 250;
// Upstream 8.0: a device is replaced after empty answers at most this often, so a passing
// block on the App's side does not turn into a burst of registrations.
const DEVICE_RESET_GAP_MS = 30000;

// Upstream 6.9 (#138/#139): playback and prefetch lookups, registration included, take
// turns, and the next one starts a second after the last ended, so a burst of requests does
// not trip the App's limits. A refusal also fails the lookups already waiting behind it.
let pacingGap = 1000;
let queue = Promise.resolve();
let readyAt = 0;
let lastRefusal = null;
let emptyLookups = 0;
let deviceResetAt = 0;
// Upstream 8.2: the endpoint that last gave a usable model is asked first.
let preferredRoute = '';

/** Tests only: the pause between lookups, in ms. Also forgets the last refusal and the device. */
export function setPlaybackPacing(ms) {
  pacingGap = ms == null ? 1000 : ms;
  readyAt = 0;
  lastRefusal = null;
  emptyLookups = 0;
  deviceResetAt = 0;
  preferredRoute = '';
  resetPlaybackDevice();
}

function replaceDevice() {
  resetPlaybackDevice();
  deviceResetAt = Date.now();
  emptyLookups = 0;
}

/**
 * Upstream 8.5: every episode of a series from the App's detail endpoint, with the shared
 * anonymous device. Rejects unless the answer is this series and lists all of its episodes.
 * A device the App turns away (110001) is replaced and the request sent once more.
 */
export async function fetchAppEpisodeList(seriesId, options = {}) {
  const sid = String(seriesId || '');
  if (!/^\d{1,30}$/.test(sid)) throw new Error('红果剧集编号无效');
  const deadline = Date.now() + (options.timeout || 9000);
  const ask = async () => {
    const identity = await getPlaybackDevice(requestJson);
    const req = videoDetailRequest(identity, sid);
    return requestJson(req.url, { method: 'POST', headers: req.headers, body: req.body }, deadline, ['series_id', 'vid']);
  };
  let response = await ask();
  if (Number(response.code) === DEVICE_TURNED_AWAY) {
    replaceDevice();
    response = await ask();
  }
  if (Number(response.code) !== 0) throw new Error('App 详情接口拒绝请求');
  const data = response.data && response.data.video_data;
  if (!data || String(data.series_id || '') !== sid) throw new Error('App 详情返回的剧集与请求不一致');
  const rows = Array.isArray(data.video_list) ? data.video_list : [];
  if (!rows.length) throw new Error('App 详情分集列表为空');
  const text = value => typeof value === 'string' ? value : '';
  const episodes = rows.map((item, i) => {
    const vid = String((item && item.vid) || '');
    if (!/^\d{1,30}$/.test(vid) || (item.series_id != null && String(item.series_id) !== sid)) throw new Error('App 详情分集数据异常');
    return { vid, vid_index: Number(item.vid_index) > 0 ? Number(item.vid_index) : i + 1, title: '', locked: item.disable_play === true };
  }).sort((a, b) => a.vid_index - b.vid_index);
  if (new Set(episodes.map(e => e.vid)).size !== episodes.length || Number(data.episode_cnt) > episodes.length) {
    throw new Error('App 详情分集列表不完整');
  }
  return {
    series_id: sid,
    series_title: text(data.series_title) || text(data.series_name),
    cover: text(data.series_cover) || text(data.cover_url),
    intro: text(data.series_intro),
    total: episodes.length,
    episodes,
  };
}

/**
 * `options.quality`: 'auto' (best first) or '720p' / '1080p'. A chosen quality only uses
 * streams whose size confirms it, closest first, and never falls back to a lower one.
 */
export function fetchAppPlayUrl(vid, options = {}) {
  vid = String(vid || '');
  if (!/^\d{1,30}$/.test(vid)) return Promise.reject(new Error('分集编号无效'));
  const refusalBefore = lastRefusal;
  const turn = queue.then(async () => {
    if (lastRefusal !== refusalBefore) throw lastRefusal;
    const pause = readyAt - Date.now();
    if (pause > 0) await wait(pause);
    const turnedAway = error => !!error && error.businessCode === DEVICE_TURNED_AWAY;
    try {
      try {
        return await fetchAppPlayUrlFresh(vid, options);
      } catch (error) {
        // Upstream 7.7: a lookup the App turned this device away from (110001) is asked once
        // more with a new device. Upstream 8.3: a lookup every endpoint answered empty ends
        // there, so the website's public stream is tried without a second round (8.0/8.1
        // asked it again with a new device); the device is still replaced for later lookups
        // below.
        if (!turnedAway(error)) throw error;
        replaceDevice();
        return await fetchAppPlayUrlFresh(vid, options);
      }
    } catch (error) {
      // The lookup failed for good. Upstream 8.0: a device that was turned away is not used
      // again, and one that keeps getting empty or timed-out lookups is replaced for the
      // next lookup once two have ended that way and 30 s have passed.
      if (error && !error.registration && (error.empty || error.timedOut || turnedAway(error))) {
        emptyLookups++;
        if (turnedAway(error) || (emptyLookups >= 2 && Date.now() - deviceResetAt >= DEVICE_RESET_GAP_MS)) replaceDevice();
      }
      if (error && error.rejected) lastRefusal = error;
      throw error;
    } finally {
      readyAt = Math.max(readyAt, Date.now() + pacingGap);
    }
  });
  queue = turn.catch(() => {});
  return turn;
}

async function fetchAppPlayUrlFresh(vid, options) {
  const wanted = options.quality === '720p' || options.quality === '1080p' ? options.quality : 'auto';
  const payload = JSON.stringify({
    biz_param: { detail_page_version: 0, device_level: 1, disable_digg_stat: false, disable_video_relate_book: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
    mixed_video_id_map: { 1004: [vid] },
    dr_scene: 'player',
  });
  // Upstream 8.0: lookups share one registered identity instead of registering one each
  // (fetchAppPlayUrl decides when it is replaced). Registration has its own 8 s budget,
  // outside the 12 s below.
  let identity;
  try { identity = await getPlaybackDevice(requestJson); } catch (error) {
    if (error && typeof error === 'object') error.registration = true;
    throw error;
  }
  const deadline = Date.now() + 12000;
  // Upstream 8.2: the preload endpoint first; 8.1: then video_tab, the player endpoint on
  // both hosts, the single-episode model endpoint on two more, and the older Argus/Ladon
  // POST last. Only an empty answer moves on to the next endpoint; any other failure ends
  // the lookup. 8.2: the endpoint that last gave a usable model goes to the front.
  const candidates = [
    { id: 'preload', create: () => preloadRequest(identity, vid) },
    { id: 'video_tab', create: () => videoTabRequest(identity, vid) },
    { id: 'player_b', create: () => playbackRequest(payload, identity, vid) },
    { id: 'player_a', create: () => playbackRequest(payload, identity, vid, true) },
  ].concat(MODEL_APIS.map((base, index) => ({ id: 'model_' + index, create: () => playbackModelRequest(identity, vid, base) })), [
    { id: 'legacy', create: () => playbackRequest(payload, identity, '') },
  ]);
  const first = candidates.filter(route => route.id === preferredRoute);
  const routes = first.concat(candidates.filter(route => route.id !== preferredRoute));
  let response = null;
  let emptyError = null;
  let answeredBy = '';
  const usable = result => { preferredRoute = answeredBy; return result; };
  for (let r = 0; r < routes.length && !response; r++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Out of time after empty answers: that, not the TV's network, is what went wrong.
      if (emptyError && deadline - Date.now() < 1000) throw emptyError;
      // Each attempt is signed anew: the signature covers the time it is sent at.
      const signed = routes[r].create();
      try {
        response = await requestJson(signed.url, signed.body ? { method: signed.method, headers: signed.headers, body: signed.body }
          : { method: signed.method, headers: signed.headers }, deadline);
        answeredBy = routes[r].id;
        break;
      } catch (error) {
        if (!error.empty) throw error;
        emptyError = error;
        if (!attempt && deadline - Date.now() >= 1000) await wait(Math.min(EMPTY_RETRY_MS, pacingGap));
      }
    }
  }
  if (!response) throw emptyError;
  emptyLookups = 0;
  if (Number(response.Code || response.code || 0) !== 0) throw businessRejected(response.Code || response.code);
  // The player endpoint nests the models under "1004" (older answers under video_model_data
  // or not at all); either way only the asked episode counts.
  const entries = response.data && (response.data['1004'] != null ? response.data['1004']
    : response.data.video_model_data != null ? response.data.video_model_data : response.data);
  const entry = entries && entries[vid];
  const model = entry && (typeof entry.video_model === 'string' ? jsonBody(entry.video_model) : entry.video_model);
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('App 接口未返回所选分集');
  // `codec` / `forceCodec` (upstream 8.2) ask the fallback model for a given codec.
  const readFallback = async (codec, forceCodec) => {
    let fallback = parseFallback(model.fallback_api);
    if (!fallback) throw new Error('App 接口未返回本集片源地址');
    if (codec) {
      const target = new URL(fallback);
      target.searchParams.set('codec_type', codec);
      if (forceCodec) target.searchParams.set('force_codec', forceCodec);
      fallback = target.href;
    }
    const outer = await requestJson(fallback, {}, deadline);
    if ([outer, outer.video_info].some(value => Number((value && (value.Code || value.code)) || 0) !== 0)) throw businessRejected();
    return outer.video_info && outer.video_info.data;
  };
  // The current model lists the streams directly (an array, or an object keyed by stream);
  // older ones only point to a fallback_api.
  const inline = !!model.video_list && typeof model.video_list === 'object' && Object.keys(model.video_list).length > 0;
  if (!inline) return usable(parsePlayModel(await readFallback(), wanted, false, 0));
  try {
    return usable(parsePlayModel(model, wanted, true, 0));
  } catch (error) {
    // Upstream 5.5: an inline model whose streams carry no encryption info at all may still
    // be read from its fallback_api, once. That model must be the same video with the same
    // full length, state its encryption, and offer nothing smaller than the inline stream.
    // Upstream 8.2: an inline model with no stream the TV can use (codec or chosen quality)
    // is asked again through its fallback_api, for HEVC and then for H.264, under the same
    // identity checks.
    const duration = Number(model.video_duration);
    const codecFallback = ['NO_COMPATIBLE_SOURCE', 'QUALITY_UNAVAILABLE', 'UNSUPPORTED_CODEC'].indexOf(error.code) >= 0;
    if ((error.missingEncryptionInfo ? !error.minimumEdge : !codecFallback) || typeof model.video_id !== 'string' || !model.video_id.trim()
      || !isFinite(duration) || duration <= 0 || !model.fallback_api) throw error;
    const sameVideo = info => {
      const fallbackDuration = Number(info && info.video_duration);
      if (!info || info.video_id !== model.video_id || !isFinite(fallbackDuration) || fallbackDuration <= 0
        || Math.abs(fallbackDuration - duration) > 0.5) {
        throw new Error('备用片源编号或完整时长无法确认，已停止取址');
      }
      return info;
    };
    if (error.missingEncryptionInfo) return usable(parsePlayModel(sameVideo(await readFallback()), wanted, true, error.minimumEdge));
    const asks = [['1'], ['0', 'h264']];
    for (let i = 0; i < asks.length; i++) {
      let info;
      try { info = sameVideo(await readFallback(asks[i][0], asks[i][1])); } catch (fallbackError) {
        // An HTTP refusal or a lost connection is the real failure; otherwise the first
        // error, which names the codec or quality, says more than the fallback's.
        if (fallbackError && (fallbackError.status || fallbackError.network)) throw fallbackError;
        continue;
      }
      try { return usable(parsePlayModel(info, wanted, false, 0)); } catch (_) { /* next codec */ }
    }
    throw error;
  }
}

/**
 * Every usable stream address in a play model, best first. `requireEncryptionInfo`: a stream
 * without a key must say it is not encrypted. `minimumEdge`: ignore smaller streams.
 */
function parsePlayModel(info, wanted, requireEncryptionInfo, minimumEdge) {
  if (!info) throw new Error('App 接口未返回本集片源模型');
  const list = info.video_list || {};
  // Samsung TVs decode HEVC in hardware, so resolution still outranks codec here
  // (the desktop app now prefers H.264 because it may have to transcode HEVC). The real
  // size outranks the quality label, which is sometimes wrong or missing.
  const compatible = Object.keys(list).map(k => list[k]).filter(item => item && (item.main_url || item.backup_url || item.backup_url_1 || Array.isArray(item.backup_url_list))).map(item => {
    const meta = item.video_meta || {};
    const codec = str(item.codec_type || meta.codec_type).toLowerCase();
    const codecRank = ['h264', 'avc', 'avc1'].indexOf(codec) >= 0 ? 0 : ['hevc', 'h265', 'hvc1', 'hev1', 'bytevc1'].indexOf(codec) >= 0 ? 1 : 2;
    const quality = str(item.quality_desc || item.definition || item.height || item.vheight || meta.definition);
    const pm = quality.match(/\d+/);
    const edge = shortEdge(item);
    return { item, codec, codecRank, quality, edge, pixels: edge || Number(pm ? pm[0] : 0) };
  }).filter(row => row.codecRank < 2 && (!minimumEdge || row.edge >= minimumEdge));
  const rows = compatible.filter(row => wanted === 'auto' || row.edge >= parseInt(wanted, 10)).sort((a, b) => wanted === 'auto'
    ? b.pixels - a.pixels || a.codecRank - b.codecRank
    : a.edge - b.edge || a.codecRank - b.codecRank);
  if (!rows.length) {
    // Upstream 4.7: only blame the chosen quality when compatible streams exist at other sizes.
    const strict = compatible.length > 0 && wanted !== 'auto';
    // Upstream 5.6 (#95): some episodes only come as ByteVC2, which no TV decodes. Say so
    // rather than blame the network (the desktop app 5.7 transcodes it; a TV cannot).
    const byteVc2 = !strict && Object.keys(list).some(k => {
      const item = list[k] || {};
      return str(item.codec_type || (item.video_meta || {}).codec_type).toLowerCase() === 'bytevc2';
    });
    throw Object.assign(new Error(strict ? '本集暂无可确认为 ' + wanted.toUpperCase() + ' 的片源，未自动降级'
      : byteVc2 ? '本集仅提供电视不支持的 ByteVC2 编码，暂时无法播放，请在红果官方 App 观看'
        : '本集暂未提供兼容的 H.264/HEVC 片源'), {
      code: strict ? 'QUALITY_UNAVAILABLE' : byteVc2 ? 'UNSUPPORTED_CODEC' : 'NO_COMPATIBLE_SOURCE', quality: wanted !== 'auto',
    });
  }
  // Every usable address, best first: a stream's main address, then its backups, then the
  // next stream. The player falls back along this list when a download fails.
  let lastError = null;
  let missingEncryptionInfo = false;
  const variants = [];
  const seen = {};
  for (let r = 0; r < rows.length; r++) {
    const selected = rows[r];
    const backups = Array.isArray(selected.item.backup_url_list) ? selected.item.backup_url_list : [];
    let contentKey;
    for (const candidate of [selected.item.main_url, selected.item.backup_url, selected.item.backup_url_1].concat(backups)) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        const media = info.key_seed ? decryptSpadeUrl(candidate, fromBase64(info.key_seed)) : cleanUrl(candidate);
        const url = checkedUrl(media, ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com']);
        if (contentKey === undefined) {
          const encryptInfo = selected.item.encrypt_info || {};
          const spade = selected.item.spade_a || encryptInfo.spade_a;
          // Upstream 5.8 (#102): some fallback models state it on the stream itself
          // (`encrypt: false`) instead of inside encrypt_info.
          const encrypt = encryptInfo.encrypt != null ? encryptInfo.encrypt : selected.item.encrypt;
          // An inline stream is encrypted unless it says otherwise: never play it as clear.
          if (requireEncryptionInfo && !spade && [false, 0, '0', 'false'].indexOf(encrypt) < 0) {
            if (encrypt == null) missingEncryptionInfo = true;
            throw new Error('本集片源缺少有效解密信息');
          }
          contentKey = spade ? deriveContentKey(spade) : null;
        }
        const identity = url + ':' + (contentKey || '');
        if (seen[identity]) continue;
        seen[identity] = true;
        const codec = selected.codec === 'bytevc1' ? 'hevc' : selected.codec;
        variants.push({
          url, contentKey, codec, quality: selected.quality, source: 'app',
          // One stream's addresses share this; the player skips a stream the TV failed to decode.
          stream: codec + '|' + (selected.edge || selected.quality),
        });
      } catch (error) { lastError = error; }
    }
  }
  if (variants.length) return Object.assign({}, variants[0], { variants });
  const error = lastError || new Error('本集暂未提供有效片源地址');
  if (missingEncryptionInfo) { error.missingEncryptionInfo = true; error.minimumEdge = rows[0].edge; }
  throw error;
}
