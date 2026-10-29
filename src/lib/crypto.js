// Pure JS hashes and AES for the TV runtime (no Node crypto). WebCrypto is used for
// AES-CTR only when available, with an identical pure-JS fallback.
import { utf8, rol32 } from './bytes.js';

const asBytes = v => (typeof v === 'string' ? utf8(v) : v);

// ---------------- MD5 ----------------
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export function md5(input) {
  const src = asBytes(input);
  const len = Math.ceil((src.length + 9) / 64) * 64;
  const data = new Uint8Array(len);
  data.set(src);
  data[src.length] = 0x80;
  const bitsLo = (src.length * 8) >>> 0;
  const bitsHi = Math.floor(src.length / 0x20000000) >>> 0;
  const dv = new DataView(data.buffer);
  dv.setUint32(len - 8, bitsLo, true);
  dv.setUint32(len - 4, bitsHi, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rol32((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[(i >> 4) * 4 + (i & 3)])) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true); odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return out;
}

// ---------------- SHA-512 ----------------
const SHA512_K = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538,
  0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
  0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
  0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab,
  0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
  0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
  0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
  0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
  0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c,
  0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
  0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
];

export function sha512(input) {
  const src = asBytes(input);
  const len = Math.ceil((src.length + 17) / 128) * 128;
  const data = new Uint8Array(len);
  data.set(src);
  data[src.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(len - 4, (src.length * 8) >>> 0);
  dv.setUint32(len - 8, Math.floor(src.length / 0x20000000) >>> 0);
  const H = new Uint32Array([
    0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
  ]);
  const W = new Uint32Array(160);
  for (let off = 0; off < len; off += 128) {
    for (let i = 0; i < 32; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      // sigma0(w[i-15]) = rotr1 ^ rotr8 ^ shr7 ; sigma1(w[i-2]) = rotr19 ^ rotr61 ^ shr6
      let xh = W[(i - 15) * 2], xl = W[(i - 15) * 2 + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = W[(i - 2) * 2]; xl = W[(i - 2) * 2 + 1];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      let lo = (s0l >>> 0) + (s1l >>> 0) + W[(i - 7) * 2 + 1] + W[(i - 16) * 2 + 1];
      const hi = (s0h >>> 0) + (s1h >>> 0) + W[(i - 7) * 2] + W[(i - 16) * 2] + Math.floor(lo / 4294967296);
      W[i * 2] = hi >>> 0;
      W[i * 2 + 1] = lo >>> 0;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let i = 0; i < 80; i++) {
      // Sigma1(e) = rotr14 ^ rotr18 ^ rotr41
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      let t1l = hl + (S1l >>> 0) + (chl >>> 0) + SHA512_K[i * 2 + 1] + W[i * 2 + 1];
      let t1h = hh + (S1h >>> 0) + (chh >>> 0) + SHA512_K[i * 2] + W[i * 2] + Math.floor(t1l / 4294967296);
      t1l >>>= 0; t1h >>>= 0;
      // Sigma0(a) = rotr28 ^ rotr34 ^ rotr39
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (mjl >>> 0);
      const t2h = ((S0h >>> 0) + (mjh >>> 0) + Math.floor(t2l / 4294967296)) >>> 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      let nl = dl + t1l;
      eh = (dh + t1h + Math.floor(nl / 4294967296)) >>> 0; el = nl >>> 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      nl = t1l + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(nl / 4294967296)) >>> 0; al = nl >>> 0;
    }
    const add = (idx, h, l) => {
      const lo = H[idx + 1] + (l >>> 0);
      H[idx] = (H[idx] + (h >>> 0) + Math.floor(lo / 4294967296)) >>> 0;
      H[idx + 1] = lo >>> 0;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl);
    add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

// ---------------- SM3 (GB/T 32905) ----------------
export function sm3(input) {
  const src = asBytes(input);
  const len = Math.ceil((src.length + 9) / 64) * 64;
  const data = new Uint8Array(len);
  data.set(src);
  data[src.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(len - 4, (src.length * 8) >>> 0);
  dv.setUint32(len - 8, Math.floor(src.length / 0x20000000) >>> 0);
  const state = new Uint32Array([0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e]);
  const words = new Uint32Array(68);
  const rotate = (x, n) => ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0;
  for (let offset = 0; offset < len; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = dv.getUint32(offset + i * 4);
    for (let i = 16; i < 68; i++) {
      const x = words[i - 16] ^ words[i - 9] ^ rotate(words[i - 3], 15);
      words[i] = x ^ rotate(x, 15) ^ rotate(x, 23) ^ rotate(words[i - 13], 7) ^ words[i - 6];
    }
    let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
      const a12 = rotate(a, 12);
      const s1 = rotate((a12 + e + rotate(i < 16 ? 0x79cc4519 : 0x7a879d8a, i)) >>> 0, 7);
      const s2 = s1 ^ a12;
      const ff = i < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c);
      const gg = i < 16 ? e ^ f ^ g : (e & f) | (~e & g);
      const t1 = (ff + d + s2 + (words[i] ^ words[i + 4])) >>> 0;
      const t2 = (gg + h + s1 + words[i]) >>> 0;
      d = c; c = rotate(b, 9); b = a; a = t1;
      h = g; g = rotate(f, 19); f = e;
      e = (t2 ^ rotate(t2, 9) ^ rotate(t2, 17)) >>> 0;
    }
    state[0] ^= a; state[1] ^= b; state[2] ^= c; state[3] ^= d;
    state[4] ^= e; state[5] ^= f; state[6] ^= g; state[7] ^= h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, state[i]);
  return out;
}

// ---------------- AES-128 ----------------
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const TE = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
(function init() {
  const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 255;
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 255;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  const mul = (a, b) => {
    let r = 0;
    while (b) {
      if (b & 1) r ^= a;
      a = (a << 1) ^ (a & 0x80 ? 0x11b : 0);
      b >>= 1;
    }
    return r & 255;
  };
  const ror = (w, n) => ((w >>> n) | (w << (32 - n))) >>> 0;
  for (let x = 0; x < 256; x++) {
    const s = SBOX[x];
    const e = ((mul(s, 2) << 24) | (s << 16) | (s << 8) | mul(s, 3)) >>> 0;
    const v = INV_SBOX[x];
    const d = ((mul(v, 14) << 24) | (mul(v, 9) << 16) | (mul(v, 13) << 8) | mul(v, 11)) >>> 0;
    TE[0][x] = e; TE[1][x] = ror(e, 8); TE[2][x] = ror(e, 16); TE[3][x] = ror(e, 24);
    TD[0][x] = d; TD[1][x] = ror(d, 8); TD[2][x] = ror(d, 16); TD[3][x] = ror(d, 24);
  }
})();

export class Aes128 {
  constructor(key) {
    if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    const ek = new Uint32Array(44);
    for (let i = 0; i < 4; i++) ek[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
    let rcon = 1;
    for (let i = 4; i < 44; i++) {
      let t = ek[i - 1];
      if (i % 4 === 0) {
        t = ((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
        rcon = (rcon << 1) ^ ((rcon >> 7) * 0x11b);
      }
      ek[i] = (ek[i - 4] ^ t) >>> 0;
    }
    this.ek = ek;
    const dk = new Uint32Array(44);
    for (let r = 0; r <= 10; r++) {
      for (let c = 0; c < 4; c++) {
        const w = ek[(10 - r) * 4 + c];
        dk[r * 4 + c] = r === 0 || r === 10 ? w
          : (TD[0][SBOX[w >>> 24]] ^ TD[1][SBOX[(w >>> 16) & 255]] ^ TD[2][SBOX[(w >>> 8) & 255]] ^ TD[3][SBOX[w & 255]]) >>> 0;
      }
    }
    this.dk = dk;
  }

  _crypt(input, inOff, output, outOff, decrypt) {
    const k = decrypt ? this.dk : this.ek;
    const T0 = decrypt ? TD[0] : TE[0], T1 = decrypt ? TD[1] : TE[1], T2 = decrypt ? TD[2] : TE[2], T3 = decrypt ? TD[3] : TE[3];
    const S = decrypt ? INV_SBOX : SBOX;
    const rd = o => ((input[inOff + o] << 24) | (input[inOff + o + 1] << 16) | (input[inOff + o + 2] << 8) | input[inOff + o + 3]);
    let a = rd(0) ^ k[0], b = rd(4) ^ k[1], c = rd(8) ^ k[2], d = rd(12) ^ k[3];
    let ki = 4;
    for (let r = 1; r < 10; r++) {
      let a2, b2, c2, d2;
      if (!decrypt) {
        a2 = T0[a >>> 24] ^ T1[(b >>> 16) & 255] ^ T2[(c >>> 8) & 255] ^ T3[d & 255] ^ k[ki];
        b2 = T0[b >>> 24] ^ T1[(c >>> 16) & 255] ^ T2[(d >>> 8) & 255] ^ T3[a & 255] ^ k[ki + 1];
        c2 = T0[c >>> 24] ^ T1[(d >>> 16) & 255] ^ T2[(a >>> 8) & 255] ^ T3[b & 255] ^ k[ki + 2];
        d2 = T0[d >>> 24] ^ T1[(a >>> 16) & 255] ^ T2[(b >>> 8) & 255] ^ T3[c & 255] ^ k[ki + 3];
      } else {
        a2 = T0[a >>> 24] ^ T1[(d >>> 16) & 255] ^ T2[(c >>> 8) & 255] ^ T3[b & 255] ^ k[ki];
        b2 = T0[b >>> 24] ^ T1[(a >>> 16) & 255] ^ T2[(d >>> 8) & 255] ^ T3[c & 255] ^ k[ki + 1];
        c2 = T0[c >>> 24] ^ T1[(b >>> 16) & 255] ^ T2[(a >>> 8) & 255] ^ T3[d & 255] ^ k[ki + 2];
        d2 = T0[d >>> 24] ^ T1[(c >>> 16) & 255] ^ T2[(b >>> 8) & 255] ^ T3[a & 255] ^ k[ki + 3];
      }
      a = a2; b = b2; c = c2; d = d2;
      ki += 4;
    }
    const cols = decrypt ? [[a, d, c, b], [b, a, d, c], [c, b, a, d], [d, c, b, a]] : [[a, b, c, d], [b, c, d, a], [c, d, a, b], [d, a, b, c]];
    for (let i = 0; i < 4; i++) {
      const [w0, w1, w2, w3] = cols[i];
      const v = ((S[w0 >>> 24] << 24) | (S[(w1 >>> 16) & 255] << 16) | (S[(w2 >>> 8) & 255] << 8) | S[w3 & 255]) ^ k[40 + i];
      output[outOff + i * 4] = v >>> 24;
      output[outOff + i * 4 + 1] = v >>> 16;
      output[outOff + i * 4 + 2] = v >>> 8;
      output[outOff + i * 4 + 3] = v;
    }
  }

  encryptBlock(input, inOff = 0, output = new Uint8Array(16), outOff = 0) { this._crypt(input, inOff, output, outOff, false); return output; }
  decryptBlock(input, inOff = 0, output = new Uint8Array(16), outOff = 0) { this._crypt(input, inOff, output, outOff, true); return output; }
}

/** AES-128-CBC decrypt without padding removal (length must be a multiple of 16). */
export function aes128CbcDecrypt(key, iv, data) {
  const aes = new Aes128(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  let prevOff = 0;
  for (let off = 0; off + 16 <= data.length; off += 16) {
    aes.decryptBlock(data, off, out, off);
    for (let i = 0; i < 16; i++) out[off + i] ^= prev[prevOff + i];
    prev = data;
    prevOff = off;
  }
  return out;
}

/** AES-128-CBC encrypt with PKCS#7 padding. */
export function aes128CbcEncrypt(key, iv, data) {
  const aes = new Aes128(key);
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
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

/**
 * CENC (AES-CTR, 8-byte IV, 64-bit block counter from 0) decrypt in place, pure JS.
 * data[off .. off+len) is XORed with the keystream.
 */
export function cencCtrInPlace(aes, iv8, data, off, len) {
  const counter = new Uint8Array(16);
  counter.set(iv8.subarray(0, 8), 0);
  const ks = new Uint8Array(16);
  let block = 0;
  for (let p = 0; p < len; p += 16, block++) {
    // 64-bit big-endian block counter; samples never exceed 2^32 blocks.
    counter[12] = block >>> 24; counter[13] = block >>> 16; counter[14] = block >>> 8; counter[15] = block;
    aes.encryptBlock(counter, 0, ks, 0);
    const n = Math.min(16, len - p);
    const base = off + p;
    for (let i = 0; i < n; i++) data[base + i] ^= ks[i];
  }
}
