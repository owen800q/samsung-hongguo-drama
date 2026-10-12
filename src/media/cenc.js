// Decrypts full-sample CENC (AES-CTR) MP4 files in memory and rebuilds a clear moov,
// so the TV's native <video> can play App-sourced episodes. Ported from the desktop
// app's decryptMp4Buffer; works on Uint8Array and yields to keep the UI responsive.
import { Aes128, cencCtrInPlace } from '../lib/crypto.js';
import { latin1, fromLatin1, concat, readU32BE, writeU32BE } from '../lib/bytes.js';

const CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta'];
const YIELD_BYTES = 2 * 1024 * 1024;

const readU64BE = (d, o) => readU32BE(d, o) * 4294967296 + readU32BE(d, o + 4);
function writeU64BE(d, v, o) {
  writeU32BE(d, Math.floor(v / 4294967296) >>> 0, o);
  writeU32BE(d, v >>> 0, o + 4);
}

function boxHeader(data, off, end) {
  let size = readU32BE(data, off);
  const typ = latin1(data, off + 4, off + 8);
  let hdr = 8;
  if (size === 1) { size = readU64BE(data, off + 8); hdr = 16; }
  else if (size === 0) size = end - off;
  return { size, typ, hdr };
}

export function parseBoxes(data, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    const { size, typ, hdr } = boxHeader(data, off, end);
    if (size < hdr || off + size > end) break;
    const children = CONTAINERS.indexOf(typ) >= 0 ? parseBoxes(data, off + hdr, off + size) : null;
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  return boxes;
}

function* walkChildren(box) {
  for (const c of box.children || []) {
    yield c;
    yield* walkChildren(c);
  }
}

function findFrma(data, start, end) {
  // sinf > frma holds the original sample entry type (avc1/hvc1/mp4a...).
  let q = start;
  while (q + 8 <= end) {
    const { size, typ, hdr } = boxHeader(data, q, end);
    if (size < 8) break;
    if (typ === 'frma' && size >= 12) return latin1(data, q + 8, q + 12);
    if (typ === 'sinf') {
      const inner = findFrma(data, q + hdr, q + size);
      if (inner) return inner;
    }
    q += size;
  }
  return '';
}

function rebuildMoov(data, moovSize, top) {
  const moovBox = top.find(b => b.typ === 'moov');
  if (!moovBox) throw new Error('no moov box');

  const clone = box => ({ typ: box.typ, off: box.off, size: box.size, hdr: box.hdr, children: box.children ? box.children.map(clone) : null });
  const prune = box => {
    if (!box.children) return box;
    box.children = box.children.filter(c => ['senc', 'saio', 'saiz', 'sgpd', 'sbgp'].indexOf(c.typ) < 0).map(prune);
    return box;
  };
  const tree = prune(clone(moovBox));

  const patches = {};
  for (const b of walkChildren(tree)) {
    if (b.typ !== 'stsd') continue;
    const content = b.off + 8;
    const count = readU32BE(data, content + 4);
    let p = content + 8;
    const entries = [];
    for (let i = 0; i < count; i++) {
      const esize = readU32BE(data, p);
      const etyp = latin1(data, p + 4, p + 8);
      if (etyp === 'encv' || etyp === 'enca') {
        const hdrSize = etyp === 'encv' ? 78 : 28;
        const original = findFrma(data, p + 8 + hdrSize, p + esize) || (etyp === 'encv' ? 'hvc1' : 'mp4a');
        const parts = [];
        const head = new Uint8Array(8 + hdrSize);
        head.set(fromLatin1(original), 4);
        head.set(data.subarray(p + 8, p + 8 + hdrSize), 8);
        parts.push(head);
        let q = p + 8 + hdrSize;
        while (q + 8 <= p + esize) {
          const h = boxHeader(data, q, p + esize);
          if (h.size < 8) break;
          if (h.typ !== 'sinf') parts.push(data.subarray(q, q + h.size));
          q += h.size;
        }
        const full = concat(parts);
        writeU32BE(full, full.length, 0);
        entries.push(full);
      } else {
        entries.push(data.subarray(p, p + esize));
      }
      p += esize;
    }
    const stsdHdr = data.slice(b.off, content + 8);
    writeU32BE(stsdHdr, entries.length, 12);
    const full = concat([stsdHdr].concat(entries));
    writeU32BE(full, full.length, 0);
    patches[b.off] = full;
  }

  const serialize = box => {
    if (!box.children) return patches[box.off] || data.subarray(box.off, box.off + box.size);
    const body = concat(box.children.map(serialize));
    const hdrb = data.slice(box.off, box.off + box.hdr);
    if (box.hdr === 8) writeU32BE(hdrb, 8 + body.length, 0);
    else { writeU32BE(hdrb, 1, 0); writeU64BE(hdrb, 16 + body.length, 8); }
    return concat([hdrb, body]);
  };

  const first = serialize(tree);
  const delta = moovSize - first.length;
  // moov precedes mdat in these files, so shrinking moov shifts every chunk offset.
  for (const b of walkChildren(tree)) {
    if (b.typ === 'stco') {
      const nc = readU32BE(data, b.off + 12);
      for (let i = 0; i < nc; i++) {
        const at = b.off + 16 + i * 4;
        const v = readU32BE(data, at);
        if (v >= delta) writeU32BE(data, v - delta, at);
      }
    } else if (b.typ === 'co64') {
      const nc = readU32BE(data, b.off + 12);
      for (let i = 0; i < nc; i++) {
        const at = b.off + 16 + i * 8;
        const v = readU64BE(data, at);
        if (v >= delta) writeU64BE(data, v - delta, at);
      }
    }
  }
  return serialize(tree);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Decrypt a complete CENC MP4 (Uint8Array or ArrayBuffer) with a 16-byte key (Uint8Array).
 * Modifies the input in place. onProgress(doneBytes, totalBytes) is optional.
 * Returns a new Uint8Array holding the clear MP4.
 */
export async function decryptMp4(input, key, { onProgress, cancel } = {}) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const total = data.length;
  const top = parseBoxes(data, 0, total);
  const moov = top.find(b => b.typ === 'moov');
  if (!moov) throw new Error('片源格式无效（缺少 moov）');

  const getBox = (boxes, typ) => (boxes || []).find(b => b.typ === typ);
  const stbls = [];
  for (const b of walkChildren({ children: top })) if (b.typ === 'stbl') stbls.push(b);

  const tracks = [];
  for (const stbl of stbls) {
    const stsz = getBox(stbl.children, 'stsz');
    const stco = getBox(stbl.children, 'stco') || getBox(stbl.children, 'co64');
    const stsc = getBox(stbl.children, 'stsc');
    const senc = getBox(stbl.children, 'senc');
    if (!stsz || !stco || !stsc || !senc) continue;
    const is64 = stco.typ === 'co64';

    const ss = readU32BE(data, stsz.off + 12);
    const n = readU32BE(data, stsz.off + 16);
    const sizes = new Array(n);
    for (let i = 0; i < n; i++) sizes[i] = ss === 0 ? readU32BE(data, stsz.off + 20 + i * 4) : ss;

    const nc = readU32BE(data, stco.off + 12);
    const chunkOffs = new Array(nc);
    for (let i = 0; i < nc; i++) chunkOffs[i] = is64 ? readU64BE(data, stco.off + 16 + i * 8) : readU32BE(data, stco.off + 16 + i * 4);

    const ns = readU32BE(data, stsc.off + 12);
    const stscTab = [];
    for (let i = 0; i < ns; i++) stscTab.push([readU32BE(data, stsc.off + 16 + i * 12), readU32BE(data, stsc.off + 20 + i * 12)]);

    const sencFlags = readU32BE(data, senc.off + 8) & 0xffffff;
    if (sencFlags & 2) throw new Error('暂不支持分段加密的片源');
    const ivCount = readU32BE(data, senc.off + 12);
    const ivs = [];
    for (let i = 0; i < ivCount; i++) ivs.push(data.slice(senc.off + 16 + i * 8, senc.off + 24 + i * 8));

    const chunkSpc = new Array(nc);
    for (let i = 0; i < stscTab.length; i++) {
      const fc = stscTab[i][0];
      const nxt = i + 1 < stscTab.length ? stscTab[i + 1][0] : nc + 1;
      for (let ci = fc - 1; ci < nxt - 1 && ci < nc; ci++) chunkSpc[ci] = stscTab[i][1];
    }

    const offs = [];
    let si = 0;
    for (let ci = 0; ci < nc; ci++) {
      let off = chunkOffs[ci];
      const spc = chunkSpc[ci] || 1;
      for (let s = 0; s < spc && si < n; s++) {
        offs.push(off);
        off += sizes[si];
        si++;
      }
    }
    tracks.push({ sizes, offs, ivs });
  }

  const aes = new Aes128(key);
  let done = 0, sinceYield = 0;
  for (const t of tracks) {
    for (let i = 0; i < t.offs.length && i < t.ivs.length; i++) {
      const off = t.offs[i], sz = t.sizes[i];
      if (off + sz > total) continue;
      cencCtrInPlace(aes, t.ivs[i], data, off, sz);
      done += sz;
      sinceYield += sz;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        if (onProgress) onProgress(done, total);
        await tick();
        if (cancel && cancel.cancelled) throw new Error('已取消');
      }
    }
  }

  const newMoov = rebuildMoov(data, moov.size, top);
  const out = [];
  let off = 0;
  while (off < total) {
    const { size, typ } = boxHeader(data, off, total);
    if (size < 8) break;
    out.push(typ === 'moov' ? newMoov : data.subarray(off, Math.min(total, off + size)));
    off += size;
  }
  if (onProgress) onProgress(total, total);
  return concat(out);
}
