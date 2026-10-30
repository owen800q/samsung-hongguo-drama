// SPDX-License-Identifier: GPL-3.0-only
// Spade algorithms adapted from woshishiq1/drpys
// commit 22261adfa31435e3b3ef5a730b8a2a75bcaf1715, spider/js/红果果[短].js,
// via N3urda/hongguoTV eea73e6a45569a2cbbb9440f7cd5290c459b0b70, and the desktop
// hongguo-drama app. TV changes: Uint8Array instead of Buffer, pure JS hashes, and no
// User-Agent header (browsers cannot set it). Since upstream 3.9 playback uses a registered
// anonymous device (playback-device.js) instead of signed requests with random IDs.
// SDK protocol constants below are not user credentials.
import { request } from '../lib/http.js';
import { getPlaybackDevice } from './playback-device.js';
import { sha512, aes128CbcDecrypt } from '../lib/crypto.js';
import { utf8, fromUtf8, fromHex, fromBase64, concat } from '../lib/bytes.js';

const VIDEO_API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/';
const DEVICE = {
  ac: 'wifi', channel: 'update_64', aid: '8662', app_name: 'novelread',
  version_code: '71332', version_name: '7.1.3.32', device_platform: 'android', os: 'android',
  ssmix: 'a', device_type: '25053RT47C', device_brand: 'Redmi', language: 'zh', os_api: '36',
  os_version: '16', manifest_version_code: '71332', resolution: '1280*2772', dpi: '520',
  update_version_code: '71332', host_abi: 'arm64-v8a', dragon_device_type: 'phone', pv_player: '71332',
  compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0',
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
// Upstream 3.9: with a registered device identity this endpoint answers unsigned requests;
// with per-request random IDs it now answers HTTP 200 with an empty body.
function playbackRequest(payload, identity) {
  const query = pythonUrlEncode(Object.assign({}, DEVICE, identity, { _rticket: String(Date.now()) }));
  return { url: VIDEO_API + '?' + query, body: utf8(payload), headers: {
    Accept: 'application/json; charset=utf-8,application/x-protobuf', 'Content-Type': 'application/json; charset=UTF-8',
  } };
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
    if (error && error.status > 0) throw new Error('App 片源请求失败（HTTP ' + error.status + '）');
    // No response at all: the TV's connection, not the source, is the likely cause.
    throw Object.assign(new Error('App 片源请求失败，请稍后重试'), { network: true });
  }
  // XHR follows redirects itself; make sure we still ended on an allowed host.
  if (res.url) checkedUrl(res.url, ['fqnovel.com', 'snssdk.com']);
  if (typeof res.data === 'string' && !res.data.trim()) throw Object.assign(new Error('App 接口返回空响应，可能是设备鉴权问题'), { empty: true });
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

/**
 * `options.quality`: 'auto' (best first) or '720p' / '1080p'. A chosen quality only uses
 * streams whose size confirms it, closest first, and never falls back to a lower one.
 */
export async function fetchAppPlayUrl(vid, options = {}) {
  vid = String(vid || '');
  const wanted = options.quality === '720p' || options.quality === '1080p' ? options.quality : 'auto';
  if (!/^\d{1,30}$/.test(vid)) throw new Error('分集编号无效');
  const deadline = Date.now() + 15000;
  const payload = JSON.stringify({
    biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
    mixed_video_id_map: { 1004: [vid] },
  });
  // Upstream 4.4: the API can start answering one device with empty bodies mid-run, while a
  // newly registered one works. Renew the device once and retry, if enough time is left.
  let identity = await getPlaybackDevice(requestJson);
  let response;
  for (let attempt = 0; ; attempt++) {
    const signed = playbackRequest(payload, identity);
    try {
      response = await requestJson(signed.url, { method: 'POST', headers: signed.headers, body: signed.body }, deadline);
      break;
    } catch (error) {
      if (attempt || !error.empty || deadline - Date.now() < 8000) throw error;
      const renewed = await getPlaybackDevice(requestJson, identity);
      if (renewed === identity) throw error;
      identity = renewed;
    }
  }
  if (Number(response.Code || response.code || 0) !== 0) throw new Error('App 接口暂未提供本集播放信息');
  const entry = response.data && response.data[vid];
  const model = entry && (typeof entry.video_model === 'string' ? jsonBody(entry.video_model) : entry.video_model);
  if (!model) throw new Error('App 接口未返回所选分集');
  // The current model lists the streams directly; older ones only point to a fallback_api.
  const inline = Array.isArray(model.video_list) && model.video_list.length > 0;
  let info = model;
  if (!inline) {
    const fallback = parseFallback(model.fallback_api);
    if (!fallback) throw new Error('App 接口未返回本集片源地址');
    const outer = await requestJson(fallback, {}, deadline);
    if ([outer, outer.video_info].some(value => Number((value && (value.Code || value.code)) || 0) !== 0)) {
      throw new Error('App 接口暂未提供本集播放信息');
    }
    info = outer.video_info && outer.video_info.data;
  }
  if (!info) throw new Error('App 接口未返回本集片源模型');
  const list = info.video_list || {};
  // Samsung TVs decode HEVC in hardware, so resolution still outranks codec here
  // (the desktop app now prefers H.264 because it may have to transcode HEVC). The real
  // size outranks the quality label, which is sometimes wrong or missing.
  const rows = Object.keys(list).map(k => list[k]).filter(item => item && (item.main_url || item.backup_url || Array.isArray(item.backup_url_list))).map(item => {
    const meta = item.video_meta || {};
    const codec = str(item.codec_type || meta.codec_type).toLowerCase();
    const codecRank = ['h264', 'avc', 'avc1'].indexOf(codec) >= 0 ? 0 : ['hevc', 'h265', 'hvc1', 'hev1', 'bytevc1'].indexOf(codec) >= 0 ? 1 : 2;
    const quality = str(item.quality_desc || item.definition || item.height || item.vheight || meta.definition);
    const pm = quality.match(/\d+/);
    const edge = shortEdge(item);
    return { item, codec, codecRank, quality, edge, pixels: edge || Number(pm ? pm[0] : 0) };
  }).filter(row => row.codecRank < 2 && (wanted === 'auto' || row.edge >= parseInt(wanted, 10))).sort((a, b) => wanted === 'auto'
    ? b.pixels - a.pixels || a.codecRank - b.codecRank
    : a.edge - b.edge || a.codecRank - b.codecRank);
  if (!rows.length) {
    throw Object.assign(new Error(wanted === 'auto' ? '本集暂未提供兼容的 H.264/HEVC 片源'
      : '本集暂无可确认为 ' + wanted.toUpperCase() + ' 的片源，未自动降级'), { quality: wanted !== 'auto' });
  }
  // Every usable address, best first: a stream's main address, then its backups, then the
  // next stream. The player falls back along this list when a download fails.
  let lastError = null;
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
          // An inline stream is encrypted unless it says otherwise: never play it as clear.
          if (inline && !spade && [false, 0, '0', 'false'].indexOf(encryptInfo.encrypt) < 0) throw new Error('本集片源缺少有效解密信息');
          contentKey = spade ? deriveContentKey(spade) : null;
        }
        const identity = url + ':' + (contentKey || '');
        if (seen[identity]) continue;
        seen[identity] = true;
        variants.push({
          url, contentKey,
          codec: selected.codec === 'bytevc1' ? 'hevc' : selected.codec, quality: selected.quality, source: 'app',
        });
      } catch (error) { lastError = error; }
    }
  }
  if (variants.length) return Object.assign({}, variants[0], { variants });
  throw lastError || new Error('本集暂未提供有效片源地址');
}
