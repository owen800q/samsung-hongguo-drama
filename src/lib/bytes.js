// Byte helpers on Uint8Array (no Buffer, no BigInt: Chromium 56 has neither).

export function utf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(str));
  const s = unescape(encodeURIComponent(String(str)));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function fromUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(s));
}

export function latin1(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function fromLatin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255;
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

export function fromHex(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function toBase64(bytes, urlSafe = false) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out += B64[v >> 18] + B64[(v >> 12) & 63] + '==';
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '=';
  }
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out;
}

/** Lenient decoder (std or url-safe, ignores padding/whitespace), like Node's Buffer.from(s, 'base64'). */
export function fromBase64(str) {
  const s = String(str);
  const out = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_LOOKUP[s.charCodeAt(i) & 255];
    if (s.charCodeAt(i) > 255 || v < 0) {
      if (s[i] === '=') break;
      continue;
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

export function concat(list) {
  let len = 0;
  for (const b of list) len += b.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

export const u32 = v => Number(v) >>> 0;
export const rol32 = (v, c) => { const n = c & 31; const x = v >>> 0; return n ? ((x << n) | (x >>> (32 - n))) >>> 0 : x; };
export const ror32 = (v, c) => { const n = c & 31; const x = v >>> 0; return n ? ((x >>> n) | (x << (32 - n))) >>> 0 : x; };

export function le32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
export function be32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); return b; }
export function readU32LE(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function readU32BE(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function writeU32BE(b, v, o) { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; }
export function writeU32LE(b, v, o) { b[o] = v; b[o + 1] = v >>> 8; b[o + 2] = v >>> 16; b[o + 3] = v >>> 24; }

// ---- unsigned 64-bit values as { hi, lo } (both uint32) ----
export const u64 = (hi, lo) => ({ hi: hi >>> 0, lo: lo >>> 0 });
export function add64(a, b) {
  const lo = (a.lo + b.lo) >>> 0;
  const carry = lo < a.lo ? 1 : 0;
  return u64(a.hi + b.hi + carry, lo);
}
export const xor64 = (a, b) => u64(a.hi ^ b.hi, a.lo ^ b.lo);
export function rotr64(a, n) {
  n &= 63;
  if (n === 0) return u64(a.hi, a.lo);
  if (n === 32) return u64(a.lo, a.hi);
  if (n < 32) return u64((a.hi >>> n) | (a.lo << (32 - n)), (a.lo >>> n) | (a.hi << (32 - n)));
  n -= 32;
  return u64((a.lo >>> n) | (a.hi << (32 - n)), (a.hi >>> n) | (a.lo << (32 - n)));
}
export const readU64LE = (b, o) => u64(readU32LE(b, o + 4), readU32LE(b, o));
export function writeU64LE(b, v, o) { writeU32LE(b, v.lo, o); writeU32LE(b, v.hi, o + 4); }
