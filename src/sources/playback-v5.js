// SPDX-License-Identifier: GPL-3.0-only
// Playback v5 signing (upstream 7.5, src/native/playback-v5.js): x-helios / x-medusa over
// the final query, the gzip body actually sent and the time.
// Port of N3urda/hongguoTV 18c37c2afd0567520135abcae312352542f09083 (Signer.kt, AesV3.kt,
// V5Constants.kt), originally woshishiq1/drpys 22261ad (GPL-3.0).
// TV changes: Uint8Array instead of Buffer, 64-bit math on { hi, lo } pairs and plain
// numbers for varints (Chromium 56 has no BigInt), pure JS MD5/SM3.
// Public wire constants only: no captured sessions, SDK or account credentials.
import { md5, sm3 } from '../lib/crypto.js';
import {
  utf8, toHex, fromHex, toBase64, concat, rol32, ror32, le32, readU32BE, writeU32BE,
  u64, add64, xor64, rotr64, readU64LE, writeU64LE,
} from '../lib/bytes.js';

const MAGIC = fromHex('2d4b4fca49750d433fb5ae2c226dcc56');
const SIGN_KEY = fromHex('b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d');
const SBOX = fromHex('53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0df37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1dd12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe127400248591238922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c894545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dccd759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8de0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd288fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5d09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac91fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443fd830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f44591681335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e');
const HASH_TABLE = [0xebb64faf,0x7aadcc2,0xcf3187bf,0xe01138ff,0x6d0bfcff,0x5a30a3be,0xb41ad638,0x34180eb8,0xf233eb6f,0xb1a584cc,0xccc30dc7,0x47d1db51,0xd55653de,0x70a84fa1,0x57473c12,0xf76f0288,0x2c077f0a,0xda0dcad0,0xfbb86f6c,0xfdc4cf00,0x688a020d,0xe676c6a6,0x8cd6338b,0x1a3c8d0e,0xcce8b06b,0x6ad0ed0b,0xa0522717,0xdc71ac83,0x2285db71,0xd5b4dda6,0x736f8650,0x6560306c,0x617ce2a6,0xe423417e,0xa40e143,0x544e4032,0x88dffb2a,0x716c1ae0,0x4c467a88,0x5b23bb3,0xe1d0b866,0xbaa3dcb8,0xae3374d3,0xc3381a50,0x1702f75b,0xfe6da368,0xf0b4cf48,0x4e0ffbb8,0x72aad10d,0x26c53a3d,0xf2bce0f6,0xb4557581,0x4a257fdd,0x8c3182a2,0xab0b3b86,0x3d5dfb14,0x4f103634,0xd37b52d7,0x444eff16,0xeb0a33d1,0x6ca86f6e,0x284ba7,0x8387cfa,0x5fb37586];

function systemRandomBytes(n) {
  const out = new Uint8Array(n);
  const c = typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues ? window.crypto
    : (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto : null);
  if (c) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}
let randomBytes = systemRandomBytes;
// One per app run, like the App process they stand for.
let processNonce = '';
let processStarted = 0;
function processIdentity() {
  if (!processNonce) {
    processNonce = toBase64(randomBytes(18), true);
    processStarted = Date.now();
  }
}

/** Tests only: fixed random bytes and process start time; no arguments restores the defaults. */
export function setV5Entropy(bytes, started) {
  randomBytes = bytes || systemRandomBytes;
  processNonce = '';
  processIdentity();
  if (started != null) processStarted = started;
}

function random32() { const b = randomBytes(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
function xor(a, b) { const out = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]; return out; }

// Values here stay far below 2^53 (timestamps in ms, zigzagged 32-bit numbers).
function varint(value) {
  let n = value;
  const out = [];
  while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Uint8Array.from(out);
}
/** Fields are [tag, value] for bytes or text and [tag, number, 'sint'] for a zigzag varint. */
function proto(fields) {
  return concat(fields.map(field => {
    const tag = field[0]; const value = field[1];
    if (field[2] === 'sint') return concat([varint(tag * 8), varint(value < 0 ? -value * 2 - 1 : value * 2)]);
    const bytes = typeof value === 'string' ? utf8(value) : value;
    return bytes.length ? concat([varint(tag * 8 + 2), varint(bytes.length), bytes]) : new Uint8Array(0);
  }));
}

function getIv(initial, bytes) {
  let value = initial;
  for (let i = 0; i < bytes.length; i++) {
    value = (i & 1) === 0
      ? (value >>> 4) ^ value ^ (value << 6) ^ bytes[i]
      : ~((value >>> 7) ^ value ^ (bytes[i] | (value << 12)));
  }
  return value >>> 0;
}
function branch(query, body, ts) { return getIv(getIv(getIv(0x20230928, query), body), le32(ts)) & 15; }
function sumMd5(bytes) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i++) {
    const temp = (check >>> ((i & 1) === 0 ? 3 : 5)) ^ check;
    check = ((i & 1) === 0 ? bytes[i] ^ (check << 7) : ~(bytes[i] | (check << 11))) ^ temp;
  }
  return ((check | 4) ^ 0x1000000) >>> 0;
}

/** The 20-byte request digest; v5 only signs requests whose branch is 12. */
export function hashF13(query, body, ts) {
  if (branch(query, body, ts) !== 12) throw new Error('Unsupported v5 hash branch');
  const seed = 0x9d4a97c2;
  const count = (seed + ts) >>> 0;
  const table = HASH_TABLE.map(value => ror32(value, count + 1));
  const shift = (count + 2) & 7;
  const pad = Uint8Array.from([0xfa, 0x45, 0x61, 0xd7].map(value => ((value | (value << 8)) >>> shift) & 255));
  const data = concat([query, body, le32(ts), pad, fromHex('00000000000001a0')]);
  const schedule = [];
  for (let i = 0; i < data.length; i += 4) schedule.push(readU32BE(data, i));
  for (let i = 0; i < 112; i++) {
    const x = schedule[i + 1]; const y = schedule[i + 14];
    schedule.push((schedule[i] + schedule[i + 9] + ((rol32(x, 14) ^ rol32(x, 25) ^ (x >>> 3)) >>> 0)
      + ((rol32(y, 13) ^ rol32(y, 15) ^ (y >>> 10)) >>> 0)) >>> 0);
  }
  const initial = [0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866, 2874125293, 2152413264]
    .map(value => ror32(value, count));
  const state = initial.slice();
  // v5 branch 12 state selection: (1,3,4,0,6,5,2,0,7,7), exactly 96 rounds.
  for (let i = 0; i < 96; i++) {
    const base = seed + i;
    const n1 = (((state[4] ^ state[0]) & state[1]) ^ state[4]) >>> 0;
    const n2 = (rol32(state[1], 26) ^ rol32(state[1], 21) ^ rol32(state[1], 7)) >>> 0;
    const n4 = (schedule[base & 127] + n1 + n2 + table[base & 63] + state[6]) >>> 0;
    const n5 = (rol32(state[3], 30) ^ rol32(state[3], 19) ^ rol32(state[3], 10)) >>> 0;
    const n6 = ((state[3] & state[5]) | ((state[3] | state[5]) & state[2])) >>> 0;
    const old = state[7];
    state.unshift(state.pop());
    state[7] = (n5 + n6 + n4) >>> 0;
    state[0] = (old + n4) >>> 0;
  }
  const output = new Uint8Array(32);
  for (let i = 0; i < 8; i++) writeU32BE(output, (state[i] + initial[i]) >>> 0, i * 4);
  const folded = xor(output.subarray(0, 16), output.subarray(16));
  return concat([folded, le32(sumMd5(folded) | 0x20)]);
}

// Protocol-specific two-round carrier; this is not standard AES.
export class CarrierV5 {
  constructor(key, ts) {
    const word = ts & 3;
    this.box = SBOX.subarray(word * 256, (word + 1) * 256);
    this.con = [[2, 0, 3, 1], [1, 3, 2, 0], [3, 2, 1, 0], [2, 3, 1, 0]][word];
    this.order = [
      [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
      [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
      [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
      [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7],
    ][word];
    const initial = [0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9][word];
    const start = le32(initial);
    const expanded = new Uint8Array(48);
    for (let i = 0; i < 16; i++) expanded[i] = start[i & 3] ^ key[i];
    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const at = 4 * (i - 1);
      let a = expanded[at]; let b = expanded[at + 1]; let c = expanded[at + 2]; let d = expanded[at + 3];
      if ((i & 3) === 0) {
        const temp = ((initial >> (rounds & 24)) ^ this.box[b]) & 255;
        b = this.box[c]; c = this.box[d]; d = this.box[a]; a = temp;
      }
      rounds += 2;
      expanded[at + 4] = a ^ expanded[at - 12]; expanded[at + 5] = b ^ expanded[at - 11];
      expanded[at + 6] = c ^ expanded[at - 10]; expanded[at + 7] = d ^ expanded[at - 9];
    }
    this.keys = [];
    for (let i = 0; i < 12; i++) this.keys.push(expanded.subarray(i * 4, i * 4 + 4));
  }

  block(value) {
    let rows = [];
    for (let i = 0; i < 4; i++) rows.push(Array.from(value.subarray(i * 4, i * 4 + 4)));
    const add = offset => {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rows[i][j] ^= this.keys[offset + i][this.con[j]];
    };
    add(0);
    for (let round = 1; round <= 2; round++) {
      const before = rows.map(row => row.map(item => this.box[item]));
      const flat = [];
      this.con.forEach(i => { before[i].forEach(item => flat.push(item)); });
      rows = [0, 1, 2, 3].map(i => this.order.slice(i * 4, i * 4 + 4).map(at => flat[at]));
      if (round === 1) {
        rows = rows.map(row => this.con.map(at => row[at]));
        const xt = x => ((x << 1) ^ ((x & 128) ? 0x1b : 0)) & 255;
        for (let i = 0; i < 4; i++) {
          const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i]; const u = rows[0][i];
          rows[0][i] ^= t ^ xt(rows[0][i] ^ rows[1][i]);
          rows[1][i] ^= t ^ xt(rows[1][i] ^ rows[2][i]);
          rows[2][i] ^= t ^ xt(rows[2][i] ^ rows[3][i]);
          rows[3][i] ^= t ^ xt(rows[3][i] ^ u);
        }
      }
      add(round * 4);
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = rows[i][j] ^ this.keys[4 + i][j];
    return out;
  }

  encrypt(source, iv) {
    if (source.length < 248) throw new RangeError('V5 carrier requires at least 248 bytes');
    const wire = [6, 5, 3, 4, 2, 7, 1, 0]; const compact = [1, 7, 3, 6, 2, 0, 4, 5];
    const plaintext = new Uint8Array(32);
    for (let i = 0; i < 31; i++) for (let j = 0; j < 8; j++) {
      plaintext[i] |= ((source[i * 8 + j] >>> wire[j]) & 1) << compact[j];
    }
    plaintext[31] = 1;
    const first = this.block(xor(plaintext.subarray(0, 16), iv));
    const key = concat([first, this.block(xor(plaintext.subarray(16), first))]);
    const output = new Uint8Array(source);
    for (let i = 0; i < 31; i++) for (let j = 0; j < 8; j++) {
      const at = i * 8 + j;
      output[at] = (output[at] & ~(1 << wire[j])) | (((key[i] >>> compact[j]) & 1) << wire[j]);
    }
    return concat([key.subarray(31), output]);
  }
}

function xmxor(data, key) {
  const n = data.length;
  const encoded = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const at = (i * 4) & 28; const d0 = key[at]; const d1 = key[at + 1];
    let value = (~((((data[i] << 4) | (data[i] >>> 4)) & 255) + d0)) ^ d1;
    value = (((value & 255) << 3) | ((value & 255) >>> 5)) & 255;
    encoded[n - i - 1] = ~(((value + d1) & 255) ^ d0) & 255;
  }
  const last = encoded[n - 1] ^ encoded[n - 2]; const first = encoded[0];
  encoded[0] = (~last + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded[n - 1] ^ 254) + encoded[1]) & 255;
  encoded[2] = (encoded[2] + ((last - first) ^ (((encoded[1] << 3) | (encoded[1] >>> 5)) & 255) ^ 2)) & 255;
  for (let i = 0; i < n - 4; i++) {
    const temp = (((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 255) ^ encoded[i + 1] ^ (i + 3);
    encoded[i + 3] = (~temp + encoded[i + 3]) & 255;
  }
  encoded[n - 1] ^= encoded[n - 2];
  let sum = 0;
  for (let i = 1; i < n; i++) sum += encoded[i];
  encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;
  return encoded;
}

/** The protobuf message x-medusa carries, before the envelope transform. */
export function medusaMessage(query, f13, ts, who) {
  processIdentity();
  const flags = new Uint8Array(8);
  const device = proto([[1, 1, 'sint'], [2, 2, 'sint'], [3, '8662'], [4, who.device_id],
    [5, processNonce], [6, '!noperm!'], [12, 'Asia/Shanghai,8'], [13, 'zh_CN'],
    [22, who.os_version], [25, processStarted, 'sint'], [30, who.device_type], [31, 'HONOR'],
    [32, who.device_type], [34, 'HONOR']]);
  const env = proto([[6, 'v04.10.03.04-bugfix'], [8, who.channel], [12, device], [14, who.version_name]]);
  return proto([[1, MAGIC], [2, 5, 'sint'], [3, random32(), 'sint'], [4, '8662'], [5, who.device_id],
    [6, '646637794'], [7, who.version_name], [8, 'v04.10.03-ml-android'], [9, 0x040a0300, 'sint'],
    [10, flags], [12, ts, 'sint'], [13, f13], [14, query.subarray(0, 6)],
    [15, proto([[1, 1, 'sint'], [2, 1, 'sint'], [3, 1, 'sint'], [5, 1, 'sint']])],
    [17, ts, 'sint'], [20, 'none'], [21, 377, 'sint'], [23, env],
    [24, '{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}']]);
}

function medusa(query, f13, ts, who) {
  const message = medusaMessage(query, f13, ts, who);
  const nonce = random32(); const high = (nonce >>> 16) & 255;
  const hash = sm3(concat([SIGN_KEY, le32(nonce), SIGN_KEY]));
  const seed = le32(~(((high << 11) | (nonce >>> 24)) ^ (high >>> 5) ^ high));
  const transformed = concat([new Uint8Array(8), xmxor(message, hash)]).reverse();
  for (let i = 0; i < transformed.length; i++) transformed[i] ^= seed[(~i) & 3];
  const check = 0x18000001 | ((query[0] & 63) << 14) | ((f13[0] & 63) << 8);
  const packed = concat([Uint8Array.from([0xca]), le32(random32()), le32(check), transformed,
    Uint8Array.from([(nonce >>> 16) & 255, nonce >>> 24])]);
  const encrypted = new CarrierV5(md5(SIGN_KEY.subarray(0, 16)), ts).encrypt(packed, md5(SIGN_KEY.subarray(16)));
  const prefix = concat([le32(5), MAGIC]); const time = le32(ts);
  for (let i = 0; i < prefix.length; i++) prefix[i] ^= time[i & 3];
  return toBase64(concat([prefix, Uint8Array.from([nonce & 255, (nonce >>> 8) & 255, 0, 1]), encrypted]));
}

export function helios(ts) {
  const nonce = le32(random32());
  const ascii = utf8(toHex(md5(concat([nonce, utf8('8662')]))));
  const words = [];
  for (let i = 0; i < 4; i++) words.push(readU64LE(ascii, i * 8));
  const table = [words[0]];
  let b0 = words.shift(); let b8 = words.shift();
  for (let i = 0; i < 34; i++) {
    let value = xor64(add64(rotr64(b8, 8), b0), u64(0, i));
    words.push(value); value = xor64(value, rotr64(b0, 61));
    table.push(value); b0 = value; b8 = words.shift();
  }
  const text = utf8(ts + '-646637794-8662');
  const padding = 16 - text.length % 16;
  const data = new Uint8Array(text.length + padding).fill(padding);
  data.set(text);
  const output = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += 16) {
    let a = readU64LE(data, at); let b = readU64LE(data, at + 8);
    for (let i = 0; i < 34; i++) { b = xor64(table[i], add64(a, rotr64(b, 8))); a = xor64(b, rotr64(a, 61)); }
    writeU64LE(output, a, at); writeU64LE(output, b, at + 8);
  }
  return toBase64(concat([nonce, output]));
}

// Like the App's URLEncoder: a space is %20, '*' and '~' stay literal.
function encode(value) {
  return encodeURIComponent(value).replace(/[!'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The final URL and signature headers for one playback request. `values` are the query
 * fields, in order, and must carry the registered device_id / iid / cdid together with
 * version_name, channel, os_version and device_type; `body` is the gzip body exactly as it
 * will be sent. `_rticket` is the first of `now` .. `now + 1023` whose request falls on the
 * branch v5 signs, so the returned URL has to be sent unchanged.
 */
export function signPlaybackV5({ base, values, body, now = Date.now() }) {
  const who = {};
  Object.keys(values).forEach(key => {
    if (typeof values[key] !== 'string') throw new TypeError('V5 query fields must be strings');
    who[key] = values[key];
  });
  ['device_id', 'iid'].forEach(key => {
    if (!/^[1-9]\d{0,29}$/.test(who[key] || '')) throw new TypeError('V5 ' + key + ' must be a positive decimal string');
  });
  ['cdid', 'version_name', 'channel', 'os_version', 'device_type'].forEach(key => {
    if (!who[key] || !who[key].trim()) throw new TypeError('V5 ' + key + ' is required');
  });
  if (!(body instanceof Uint8Array) || body.length < 18 || body[0] !== 0x1f || body[1] !== 0x8b || body[2] !== 8) {
    throw new TypeError('V5 body must be gzip bytes');
  }
  const ts = Math.floor(now / 1000);
  const bodyHash = md5(body);
  if (Object.prototype.hasOwnProperty.call(who, 'ts')) who.ts = String(ts);
  for (let offset = 0; offset < 1024; offset++) {
    const ticket = String(now + offset);
    const query = Object.keys(who).filter(key => key !== '_rticket').map(key => encode(key) + '=' + encode(who[key]));
    // An existing _rticket keeps its place; otherwise it goes last.
    if (Object.prototype.hasOwnProperty.call(who, '_rticket')) query.splice(Object.keys(who).indexOf('_rticket'), 0, '_rticket=' + ticket);
    else query.push('_rticket=' + ticket);
    const text = query.join('&');
    const queryHash = sm3(utf8(text));
    if (branch(queryHash, bodyHash, ts) !== 12) continue;
    const f13 = hashF13(queryHash, bodyHash, ts);
    return {
      url: base + '?' + text,
      headers: {
        'x-khronos': String(ts), 'x-helios': helios(ts), 'x-medusa': medusa(queryHash, f13, ts, who),
        'x-ss-stub': toHex(bodyHash).toUpperCase(), 'x-ss-req-ticket': ticket,
      },
    };
  }
  throw new Error('Unable to select V5 playback signature branch within 1024 tickets');
}
