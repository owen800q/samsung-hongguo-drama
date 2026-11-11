// SPDX-License-Identifier: GPL-3.0-only
// Spade algorithms adapted from woshishiq1/drpys
// commit 22261adfa31435e3b3ef5a730b8a2a75bcaf1715, spider/js/红果果[短].js,
// via N3urda/hongguoTV eea73e6a45569a2cbbb9440f7cd5290c459b0b70, and the desktop
// hongguo-drama app. TV changes: Uint8Array instead of Buffer, pure JS hashes, and no
// User-Agent header (browsers cannot set it). Playback uses a freshly registered anonymous
// device (playback-device.js, upstream 3.9/5.5) and signed requests (app-signing.js, 5.4).
// Upstream 6.6-6.9: the video_tab GET is asked first and the older POST (gzip body, signed
// as sent) only after an empty answer; lookups take turns, one second apart. The video_tab
// parameters follow tsukiyo-zero/hongguoTV's ContentRepository.tabVideoModel (GPL-3.0-only).
// SDK protocol constants below are not user credentials.
import { request } from '../lib/http.js';
import { getPlaybackDevice } from './playback-device.js';
import { branchOf, signatureHeaders } from './app-signing.js';
import { md5, sha512, aes128CbcDecrypt } from '../lib/crypto.js';
import { utf8, fromUtf8, toHex, fromHex, fromBase64, concat, gzipStored } from '../lib/bytes.js';

const VIDEO_API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/';
const VIDEO_TAB_API = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/';
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
// Upstream 6.6/6.7: each endpoint is asked as the App version it was observed with.
const PLAYBACK_DEVICE = appVersion('74332', '7.4.3.32');
const VIDEO_TAB_DEVICE = appVersion('73932', '7.3.9.32');

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
// Upstream 5.4 signs playback requests again: unsigned ones now get HTTP 200 with an empty
// body. The signature covers the final query, the bytes actually sent and the timestamp, so
// it is rebuilt for every attempt. Like upstream, jitter _rticket until the server would
// pick signature branch 0. With `videoId` this is the video_tab GET, which has no body
// (signed as sixteen zero bytes, not MD5 of nothing); without it, the older POST, whose JSON
// body is sent gzipped (upstream 6.6).
export function playbackRequest(payload, identity, videoId) {
  const body = videoId ? null : gzipStored(utf8(payload));
  const khronos = Math.floor(Date.now() / 1000);
  const ticketBase = Date.now();
  const device = Object.assign({}, videoId ? VIDEO_TAB_DEVICE : PLAYBACK_DEVICE, identity);
  const values = videoId ? {
    video_id: videoId, video_id_type: '0', device_level: '1', need_all_video_definition: '1', need_mp4_align: '0',
    use_os_player: '0', video_platform: '1024', source: '0', from_video_id: '',
  } : {};
  let url = '';
  let ticket = ticketBase;
  for (let n = 0; ; n++) {
    ticket = ticketBase + n;
    url = (videoId ? VIDEO_TAB_API : VIDEO_API) + '?' + pythonUrlEncode(Object.assign({}, device, values, { ts: String(khronos), _rticket: String(ticket) }));
    if (branchOf(url, body, khronos) === 0) break;
    if (n === 127) throw new Error('无法生成播放请求签名');
  }
  const headers = Object.assign({
    Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'x-ss-req-ticket': String(ticket), 'sdk-version': '2', 'x-xs-from-web': '0', 'x-tt-dt': '',
    'passport-sdk-version': videoId ? '50561' : '5051452', 'x-ss-dp': String(device.aid),
    'x-tt-store-region': 'cn', 'x-tt-store-region-src': 'did',
  }, signatureHeaders(url, body, khronos, device));
  if (body) Object.assign(headers, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Encoding': 'gzip', 'x-ss-stub': toHex(md5(body)).toUpperCase() });
  else headers['x-tt-request-tag'] = 't=0;n=0';
  return { url, body, headers, method: videoId ? 'GET' : 'POST' };
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
async function requestJson(url, options, deadline) {
  url = checkedUrl(url, ['fqnovel.com', 'snssdk.com']);
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw Object.assign(new Error('App 片源请求超时'), { network: true });
  let res;
  try {
    res = await request(url, Object.assign({}, options, { responseType: 'text', timeout }));
  } catch (error) {
    // Upstream 5.7: 403/429 is the App refusing this TV, not a passing outage.
    if (error && error.status > 0) throw Object.assign(new Error('App 片源请求失败（HTTP ' + error.status + '）'), { rejected: error.status === 403 || error.status === 429 });
    // No response at all: the TV's connection, not the source, is the likely cause.
    throw Object.assign(new Error('App 片源请求失败，请稍后重试'), { network: true });
  }
  // XHR follows redirects itself; make sure we still ended on an allowed host.
  if (res.url) checkedUrl(res.url, ['fqnovel.com', 'snssdk.com']);
  if (typeof res.data === 'string' && !res.data.trim()) throw Object.assign(new Error('App 接口返回空响应（HTTP 200），原因尚未确认'), { empty: true });
  const parsed = typeof res.data === 'string' ? jsonBody(res.data) : res.data;
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
function businessRejected() { return Object.assign(new Error('App 接口暂未提供本集播放信息'), { rejected: true }); }

// Upstream 6.9 (#138/#139): playback and prefetch lookups, registration included, take
// turns, and the next one starts a second after the last ended, so a burst of requests does
// not trip the App's limits. A refusal also fails the lookups already waiting behind it.
let pacingGap = 1000;
let queue = Promise.resolve();
let readyAt = 0;
let lastRefusal = null;

/** Tests only: the pause between lookups, in ms. Also forgets the last refusal. */
export function setPlaybackPacing(ms) {
  pacingGap = ms == null ? 1000 : ms;
  readyAt = 0;
  lastRefusal = null;
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
    try {
      return await fetchAppPlayUrlFresh(vid, options);
    } catch (error) {
      if (error && error.rejected) lastRefusal = error;
      throw error;
    } finally {
      readyAt = Date.now() + pacingGap;
    }
  });
  queue = turn.catch(() => {});
  return turn;
}

async function fetchAppPlayUrlFresh(vid, options) {
  const wanted = options.quality === '720p' || options.quality === '1080p' ? options.quality : 'auto';
  const payload = JSON.stringify({
    biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
    mixed_video_id_map: { 1004: [vid] },
  });
  // Upstream 5.5: a registered identity may only be good for one playback request, so each
  // lookup registers its own. Registration has its own 8 s budget, outside the 12 s below.
  let identity = await getPlaybackDevice(requestJson);
  const deadline = Date.now() + 12000;
  let response;
  for (let attempt = 0; ; attempt++) {
    // Upstream 6.9: video_tab first; only an empty answer gets one try on the older POST.
    const signed = playbackRequest(payload, identity, attempt ? '' : vid);
    try {
      response = await requestJson(signed.url, { method: signed.method, headers: signed.headers, body: signed.body }, deadline);
      break;
    } catch (error) {
      if (attempt || !error.empty || deadline - Date.now() < 1000) throw error;
      // With a new identity when time allows; a failed registration keeps the previous one.
      if (deadline - Date.now() >= 8000) {
        try { identity = await getPlaybackDevice(requestJson); } catch (_) { /* keep the previous identity */ }
      }
      if (deadline - Date.now() < 1500) throw error;
      await wait(pacingGap);
    }
  }
  if (Number(response.Code || response.code || 0) !== 0) throw businessRejected();
  // video_tab nests the models under video_model_data; either way only the asked episode counts.
  const entries = response.data && (response.data.video_model_data != null ? response.data.video_model_data : response.data);
  const entry = entries && entries[vid];
  const model = entry && (typeof entry.video_model === 'string' ? jsonBody(entry.video_model) : entry.video_model);
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('App 接口未返回所选分集');
  const readFallback = async () => {
    const fallback = parseFallback(model.fallback_api);
    if (!fallback) throw new Error('App 接口未返回本集片源地址');
    const outer = await requestJson(fallback, {}, deadline);
    if ([outer, outer.video_info].some(value => Number((value && (value.Code || value.code)) || 0) !== 0)) throw businessRejected();
    return outer.video_info && outer.video_info.data;
  };
  // The current model lists the streams directly (an array, or an object keyed by stream
  // from video_tab); older ones only point to a fallback_api.
  const inline = !!model.video_list && typeof model.video_list === 'object' && Object.keys(model.video_list).length > 0;
  if (!inline) return parsePlayModel(await readFallback(), wanted, false, 0);
  try {
    return parsePlayModel(model, wanted, true, 0);
  } catch (error) {
    // Upstream 5.5: an inline model whose streams carry no encryption info at all may still
    // be read from its fallback_api, once. That model must be the same video with the same
    // full length, state its encryption, and offer nothing smaller than the inline stream.
    const duration = Number(model.video_duration);
    if (!error.missingEncryptionInfo || !error.minimumEdge || typeof model.video_id !== 'string' || !model.video_id.trim()
      || !isFinite(duration) || duration <= 0 || !model.fallback_api) throw error;
    const info = await readFallback();
    const fallbackDuration = Number(info && info.video_duration);
    if (!info || info.video_id !== model.video_id || !isFinite(fallbackDuration) || fallbackDuration <= 0
      || Math.abs(fallbackDuration - duration) > 0.5) {
      throw new Error('备用片源编号或完整时长无法确认，已停止取址');
    }
    return parsePlayModel(info, wanted, true, error.minimumEdge);
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
  const compatible = Object.keys(list).map(k => list[k]).filter(item => item && (item.main_url || item.backup_url || Array.isArray(item.backup_url_list))).map(item => {
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
    for (const candidate of [selected.item.main_url, selected.item.backup_url].concat(backups)) {
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
