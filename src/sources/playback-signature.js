// SPDX-License-Identifier: GPL-3.0-only
// Playback-only 551 Argus/Ladon signing, from the desktop hongguo-drama app 6.9/7.0
// (src/native/playback-signature.js), itself adapted from N3urda/hongguoTV
// 7444bb01aec7b0420740103e551c45f1f66101c9, kotlin-tv/core/src/main/kotlin/com/hongguotv/core/
// Argus.kt (blob 9f1b06f16c778f07d1bd9e1f8e9a596590e57213), which attributes GPL-3.0-only
// ch6vip/fqapp rust/src/sign/{argus,simon,ladon,protobuf}.rs.
// TV changes: Uint8Array instead of Buffer, 64-bit math on { hi, lo } pairs (Chromium 56 has
// no BigInt), and the pure JS MD5/SM3/AES of lib/crypto.js. Only the playback model requests
// use it; registration is unchanged. Protocol constants below are not account credentials.
import { md5, sm3, Aes128 } from '../lib/crypto.js';
import {
  utf8, toHex, fromHex, toBase64, concat, u64, add64, xor64, rotr64, readU64LE, writeU64LE,
} from '../lib/bytes.js';

const LICENSE_ID = '1611921764';
const SIGN_KEY = fromHex('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304');
const AES_KEY = fromHex('d31e3718288a1027baab59f146a09a9c');
const AES_IV = fromHex('ea180a0336ed352fcd24e4d50018ae54');
const MAGIC8 = fromHex('f2f7fcfff2f7fcff');
const TAIL9 = fromHex('eafb2cfe8568519154');
// Simon's round constant sequence z, 62 bits.
const Z_HI = 0x3dc94c3a;
const Z_LO = 0x046d678b;

const rotl64 = (a, n) => rotr64(a, 64 - n);
const and64 = (a, b) => u64(a.hi & b.hi, a.lo & b.lo);

function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues ? window.crypto
    : (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto : null);
  if (c) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A value reduced to an unsigned 32-bit integer, as protobuf's uint32 does. */
function uint32(value) {
  const n = Math.floor(Number(value));
  return ((n % 4294967296) + 4294967296) % 4294967296;
}
function varint(value) {
  let n = uint32(value);
  const out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return new Uint8Array(out);
}
export class ProtoBuf {
  constructor() { this.parts = []; }
  putVarint(tag, value) { this.parts.push(varint(tag * 8), varint(value)); return this; }
  putBytes(tag, bytes) { this.parts.push(varint(tag * 8 + 2), varint(bytes.length), bytes); return this; }
  putUtf8(tag, value) { return this.putBytes(tag, utf8(value)); }
  putProtobuf(tag, value) { return this.putBytes(tag, value.toBuf()); }
  toBuf() { return concat(this.parts); }
}

// Simon 128/256: four 64-bit key words, two 64-bit block words, 72 rounds.
export const Simon = {
  keyExpansion(key) {
    if (!Array.isArray(key) || key.length !== 4) throw new TypeError('Four Simon key words required');
    const expanded = key.map(word => u64(word.hi, word.lo));
    for (let i = 4; i < 72; i++) {
      let tmp = xor64(rotr64(expanded[i - 1], 3), expanded[i - 3]);
      tmp = xor64(tmp, rotr64(tmp, 1));
      const at = (i - 4) % 62;
      const bit = at < 32 ? (Z_LO >>> at) & 1 : (Z_HI >>> (at - 32)) & 1;
      const previous = expanded[i - 4];
      expanded.push(u64(~previous.hi ^ tmp.hi, ~previous.lo ^ tmp.lo ^ bit ^ 3));
    }
    return expanded;
  },
  encrypt(left, right, key) {
    let x = left;
    let y = right;
    const keys = Simon.keyExpansion(key);
    for (let i = 0; i < keys.length; i++) {
      const previous = y;
      y = xor64(xor64(xor64(x, and64(rotl64(y, 1), rotl64(y, 8))), rotl64(y, 2)), keys[i]);
      x = previous;
    }
    return [x, y];
  },
};

function pad16(data) {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}
function queryParam(query, name) {
  const decode = value => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch (_) { return value; } };
  const parts = query.split('&');
  for (let i = 0; i < parts.length; i++) {
    const at = parts[i].indexOf('=');
    if (decode(at < 0 ? parts[i] : parts[i].slice(0, at)) === name) return decode(at < 0 ? '' : parts[i].slice(at + 1));
  }
  return null;
}
/** AES-128-CBC over whole blocks, no padding added. */
function aesCbcRaw(key, iv, data) {
  const aes = new Aes128(key);
  const out = new Uint8Array(data);
  let prev = iv;
  let prevOff = 0;
  for (let off = 0; off < out.length; off += 16) {
    for (let i = 0; i < 16; i++) out[off + i] ^= prev[prevOff + i];
    aes.encryptBlock(out, off, out, off);
    prev = out;
    prevOff = off;
  }
  return out;
}

export const Argus = {
  /** `stubHex`: MD5 of the body as sent, in hex; '' for a request without a body. */
  bodyHash(stubHex) {
    if (!stubHex) return sm3(new Uint8Array(16)).subarray(0, 6);
    return sm3(/^(?:[a-f\d]{2})+$/i.test(stubHex) ? fromHex(stubHex) : new Uint8Array(0)).subarray(0, 6);
  },
  queryHash(query) { return sm3(query ? utf8(query) : new Uint8Array(16)).subarray(0, 6); },
  /** `ts` in seconds; `aid` and `licenseId` as decimal strings; `randField` any integer. */
  sign(query, stubHex, ts, aid, licenseId, deviceId, installId, randField) {
    if ([query, stubHex, deviceId, installId].some(value => typeof value !== 'string')) throw new TypeError('String protocol fields required');
    const bean = new ProtoBuf().putVarint(1, 1077940818).putVarint(2, 2).putVarint(3, randField)
      .putUtf8(4, String(aid || '1967')).putUtf8(5, deviceId).putUtf8(6, String(licenseId || LICENSE_ID))
      .putUtf8(7, queryParam(query, 'version_name') || '').putUtf8(8, 'v04.04.05-ov-android')
      .putVarint(9, 134744640).putBytes(10, new Uint8Array(8)).putVarint(11, 0).putVarint(12, Number(ts) * 2)
      .putBytes(13, Argus.bodyHash(stubHex)).putBytes(14, Argus.queryHash(query))
      .putProtobuf(15, new ProtoBuf().putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xc792eccc))
      .putUtf8(16, installId).putUtf8(20, 'none').putVarint(21, 738)
      .putProtobuf(23, new ProtoBuf().putUtf8(1, 'NX551J').putVarint(2, 8196).putVarint(4, 0x80e0d800)).putVarint(25, 2);
    const protobuf = pad16(bean.toBuf());
    const key = [0, 8, 16, 24].map(at => readU64LE(SIGN_KEY, at));
    const framed = new Uint8Array(8 + protobuf.length + 9);
    framed.set(MAGIC8);
    for (let at = 0; at < protobuf.length; at += 16) {
      const encrypted = Simon.encrypt(readU64LE(protobuf, at), readU64LE(protobuf, at + 8), key);
      writeU64LE(framed, encrypted[0], 8 + at);
      writeU64LE(framed, encrypted[1], 16 + at);
    }
    framed.set(TAIL9, 8 + protobuf.length);
    for (let i = 8; i < framed.length; i++) framed[i] ^= MAGIC8[i % 8];
    framed.reverse();
    return toBase64(concat([fromHex('f281'), aesCbcRaw(AES_KEY, AES_IV, pad16(concat([framed, utf8('ao')])))]));
  },
};

export const Ladon = {
  /** `randomBytes`: four bytes; `ts`, `licenseId` and `aid` are written in decimal. */
  encrypt(ts, licenseId, aid, random) {
    if (!(random instanceof Uint8Array) || random.length !== 4) throw new TypeError('Four Ladon random bytes required');
    const ascii = utf8(toHex(md5(concat([random, utf8(String(aid))]))));
    const words = [0, 8, 16, 24].map(at => readU64LE(ascii, at));
    const table = [words[0]];
    const queue = words.slice(2);
    let b0 = words[0];
    let b8 = words[1];
    for (let i = 0; i < 34; i++) {
      let x8 = xor64(add64(rotr64(b8, 8), b0), u64(0, i));
      queue.push(x8);
      x8 = xor64(x8, rotl64(b0, 3));
      table.push(x8);
      b0 = x8;
      b8 = queue.shift();
    }
    const out = pad16(utf8(ts + '-' + licenseId + '-' + aid));
    for (let at = 0; at < out.length; at += 16) {
      let a = readU64LE(out, at);
      let b = readU64LE(out, at + 8);
      for (let i = 0; i < 34; i++) {
        b = xor64(table[i], add64(a, rotr64(b, 8)));
        a = xor64(b, rotl64(a, 3));
      }
      writeU64LE(out, a, at);
      writeU64LE(out, b, at + 8);
    }
    return toBase64(concat([random, out]));
  },
};

/**
 * The signature headers of one playback model request. `query` is the final query string,
 * `body` the bytes actually sent (null for a GET) and `ts` the request time in seconds.
 * `randField` and `ladonRandom` are for tests; they are random otherwise.
 */
export function signPlayer({ query, body = null, ts, randField, ladonRandom }) {
  if (typeof query !== 'string' || (body !== null && !(body instanceof Uint8Array))) throw new TypeError('Final query string and raw body bytes required');
  if (!Number.isSafeInteger(ts) || ts < 0) throw new TypeError('Timestamp in whole seconds required');
  const aidValue = queryParam(query, 'aid') || '';
  const aid = /^\d{1,15}$/.test(aidValue) && Number(aidValue) > 0 ? String(Number(aidValue)) : '1967';
  const stub = body && body.length ? toHex(md5(body)) : '';
  if (randField === undefined) { const r = randomBytes(4); randField = (r[0] | (r[1] << 8) | (r[2] << 16) | (r[3] << 24)) >>> 0; }
  if (ladonRandom === undefined) ladonRandom = randomBytes(4);
  const headers = {
    'x-ss-req-ticket': String(ts * 1000), 'x-khronos': String(ts),
    'x-ladon': Ladon.encrypt(ts, LICENSE_ID, aid, ladonRandom),
    'x-argus': Argus.sign(query, stub, ts, aid, LICENSE_ID, queryParam(query, 'device_id') || '', '', randField),
  };
  if (stub) headers['x-ss-stub'] = stub;
  return headers;
}
