// SPDX-License-Identifier: GPL-3.0-only
// ttEncrypt and registration fields adapted from the desktop hongguo-drama app 3.9
// (src/native/playback-device.js), itself adapted from tsukiyo-zero/hongguoTV,
// commit 388931852ddc614db8b00775a3dc54c5ede6307f,
// kotlin-tv/core/src/main/kotlin/com/hongguotv/core/DeviceRegister.kt
// (itself adapted from charlie901208/HGTV feat/phone-login, GPL-3.0-only).
// Changes: fixed anonymous phone profile; in-memory identity only; no cookies or tokens.
// TV changes: pure JS gzip/AES/hashes, no User-Agent header, and a failed registration
// is retried after a short pause instead of only after an app restart.
import { md5, sha512, aes128CbcEncrypt } from '../lib/crypto.js';
import { utf8, toHex, fromHex, concat, randomBytes, randomUuid, gzipStored } from '../lib/bytes.js';

const REGISTER_URL = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const KDF_SALT = fromHex('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58');
const RETRY_AFTER_MS = 30 * 1000;
let registration = null;
let failedAt = 0;

function responseId(response, name) {
  const preferred = response && response[name + '_str'];
  const value = preferred === undefined || preferred === null || preferred === '' ? response && response[name] : preferred;
  // JSON numbers past 2^53 have already lost digits; only the _str form is exact then.
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : '';
}

/** The encrypted device_register body (exported for tests). */
export function registrationBody(now, cdid) {
  const header = {
    display_name: '红果免费短剧', update_version_code: 73932, manifest_version_code: 73932,
    app_version_minor: '7.3.9.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
    app_version: '7.3.9.32', version_code: 73932, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
    sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: '16', os_api: 36,
    device_model: '25053RT47C', device_brand: 'Redmi', device_manufacturer: 'Redmi',
    cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: 520, display_density: 'mdpi',
    resolution: '1280x2772', language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
    carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
    rom_version: 'W528JS release-keys', cdid,
    sig_hash: '56a962410c494bbaf0b58dba20cae56f', openudid: toHex(randomBytes(8)),
    clientudid: randomUuid(), ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai',
    tz_offset: 28800, sim_region: 'cn', sim_serial_number: [], oaid_may_support: false,
    req_id: randomUuid(), device_platform: 'android',
    custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' }, pre_installed_channel: '',
    apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
  };
  const compressed = gzipStored(utf8(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
  const random = randomBytes(32);
  const derived = sha512(concat([sha512(random), KDF_SALT]));
  const encrypted = aes128CbcEncrypt(derived.subarray(0, 16), derived.subarray(16, 32), concat([sha512(compressed), compressed]));
  return concat([fromHex('746305100000'), random, encrypted]);
}

async function register(requestJson) {
  const now = Date.now();
  const cdid = randomUuid();
  const data = registrationBody(now, cdid);
  let response;
  try {
    response = await requestJson(REGISTER_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
        'log-encode-type': 'gzip', 'x-ss-dp': '8662', 'x-ss-req-ticket': String(now),
        'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
        'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
        'x-ss-stub': toHex(md5(data)).toUpperCase(),
      },
      body: data,
    }, now + 8000);
  } catch (error) {
    if (error && error.network) throw error;
    response = null;
  }
  const deviceId = responseId(response, 'device_id');
  const iid = responseId(response, 'install_id');
  if (!deviceId || !iid || Number((response && (response.code != null ? response.code : response.Code)) || 0) !== 0) {
    throw Object.assign(new Error('红果备用接口匿名设备注册失败，请稍后重试'), { code: 'DEVICE_REGISTRATION_FAILED' });
  }
  return Object.freeze({ device_id: deviceId, iid, cdid });
}

/**
 * The anonymous App identity shared by playback and prefetch in this app session.
 * The App playback API answers random, unregistered device IDs with an empty body.
 * Concurrent callers share one registration; after a failure, callers within the next
 * 30 s get the same error, so prefetch and retries do not register a burst of devices.
 */
export function getPlaybackDevice(requestJson) {
  if (registration && failedAt && Date.now() - failedAt >= RETRY_AFTER_MS) { registration = null; failedAt = 0; }
  if (!registration) {
    const attempt = register(requestJson);
    registration = attempt;
    attempt.catch(() => { if (registration === attempt) failedAt = Date.now(); });
  }
  return registration;
}

/** Tests only: forget the shared identity. */
export function resetPlaybackDevice() { registration = null; failedAt = 0; }
