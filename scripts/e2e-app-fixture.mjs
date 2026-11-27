// Stand-in App episodes for the e2e run. Since November 2026 the App's playback endpoints
// answer every anonymous lookup with an empty body, so the checks that follow an App stream
// (download, decrypt, switch address or stream) have nothing live to run against. This builds
// what such an answer used to hold: full-sample CENC MP4s (HEVC + AAC, `senc` in `stbl`,
// `encv`/`enca` entries naming the real codec in `sinf > frma`) and a play model that lists
// them with their key. Needs ffmpeg with libx265.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseBoxes } from '../src/media/cenc.js';

export const APP_KEY = '71aa250f3253f041d14edbdce6ecebeb';
/** Short edges of the stand-in streams, best first. All HEVC: no Chromium build decodes it in software. */
export const APP_SIZES = [1080, 720, 540];
export const APP_MEDIA_HOST = 'https://v3-e2e.qznovelvod.com';
/** Playback lookups of the App: every App endpoint except the series detail one. */
export const APP_PLAYBACK = /(?:api5-normal[^/]*\.fqnovel\.com|reading\.snssdk\.com)\/(?!novel\/player\/video_detail\/)/;

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};

/** Inverse of deriveContentKey in src/sources/app-source.js. */
export function spadeFor(hex) {
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

/**
 * Encrypt every sample of a plain, unfragmented MP4 whose moov comes last (ffmpeg's default)
 * the way App episodes are: AES-128-CTR over whole samples, an 8-byte IV per sample.
 */
export function encryptMp4(clear, keyHex) {
  const data = Buffer.from(clear);
  const key = Buffer.from(keyHex, 'hex');
  const top = parseBoxes(data, 0, data.length);
  const moov = top[top.length - 1];
  if (!moov || moov.typ !== 'moov') throw new Error('fixture needs an MP4 with moov last');
  const patches = new Map();
  const visit = node => (node.children || []).forEach(child => { if (child.typ === 'stbl') protect(child); else visit(child); });
  const protect = stbl => {
    const get = type => stbl.children.find(b => b.typ === type);
    const stsz = get('stsz'); const stco = get('stco'); const stsc = get('stsc'); const stsd = get('stsd');
    const fixed = data.readUInt32BE(stsz.off + 12);
    const count = data.readUInt32BE(stsz.off + 16);
    const sizes = Array.from({ length: count }, (_, i) => fixed || data.readUInt32BE(stsz.off + 20 + i * 4));
    const chunks = Array.from({ length: data.readUInt32BE(stco.off + 12) }, (_, i) => data.readUInt32BE(stco.off + 16 + i * 4));
    const runs = Array.from({ length: data.readUInt32BE(stsc.off + 12) }, (_, i) => [data.readUInt32BE(stsc.off + 16 + i * 12), data.readUInt32BE(stsc.off + 20 + i * 12)]);
    const ivs = [];
    let sample = 0;
    chunks.forEach((offset, index) => {
      let perChunk = 1;
      runs.forEach(run => { if (run[0] <= index + 1) perChunk = run[1]; });
      for (let s = 0; s < perChunk && sample < count; s++, sample++) {
        const iv = crypto.randomBytes(8);
        ivs.push(iv);
        const cipher = crypto.createCipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
        cipher.update(data.subarray(offset, offset + sizes[sample])).copy(data, offset);
        offset += sizes[sample];
      }
    });
    // One sample entry: rename it and say inside what it really is.
    const entry = stsd.off + 16;
    const size = data.readUInt32BE(entry);
    const original = data.subarray(entry + 4, entry + 8);
    const video = /^(hvc1|hev1|avc1|avc3)$/.test(original.toString('latin1'));
    const sinf = box('sinf', box('frma', original), box('schm', u32(0), Buffer.from('cenc'), u32(0x10000)));
    const renamed = Buffer.concat([u32(size + sinf.length), Buffer.from(video ? 'encv' : 'enca'), data.subarray(entry + 8, entry + size), sinf]);
    patches.set(stsd.off, box('stsd', data.subarray(stsd.off + 8, stsd.off + 16), renamed));
    stbl.senc = box('senc', u32(0), u32(ivs.length), ...ivs);
  };
  visit(moov);
  const serialize = node => {
    if (!node.children) return patches.get(node.off) || data.subarray(node.off, node.off + node.size);
    return box(node.typ, ...node.children.map(serialize), ...(node.senc ? [node.senc] : []));
  };
  return Buffer.concat([data.subarray(0, moov.off), serialize(moov)]);
}

/** The encrypted stand-in streams, by short edge. Built once per machine with ffmpeg. */
export function appStreams() {
  const streams = {};
  APP_SIZES.forEach(edge => {
    const file = path.join(os.tmpdir(), 'hgtv-e2e-app-' + edge + '-30s.mp4');
    if (!fs.existsSync(file)) {
      const clear = file + '.clear.mp4';
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=' + edge + 'x' + Math.round(edge * 16 / 9) + ':rate=5',
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
        '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-b:v', '300k', '-c:a', 'aac', '-b:a', '32k', clear]);
      fs.writeFileSync(file, encryptMp4(fs.readFileSync(clear), APP_KEY));
      fs.unlinkSync(clear);
    }
    streams[edge] = fs.readFileSync(file);
  });
  return streams;
}

/** The episode a playback lookup asks for: in the query (video_tab) or the gzip JSON body. */
export function askedVid(request) {
  const inQuery = new URL(request.url()).searchParams.get('video_id');
  if (inQuery) return inQuery;
  try {
    const body = JSON.parse(zlib.gunzipSync(request.postDataBuffer()).toString());
    return String(body.video_id || Object.values(body.mixed_video_id_map || {})[0][0]);
  } catch (_) { return ''; }
}

/** What the App answered a lookup of `vid` with when it still did: an inline model of three streams. */
export function appAnswer(vid) {
  const video_list = APP_SIZES.map(edge => ({
    codec_type: 'bytevc1', definition: edge + 'p', vwidth: edge, vheight: Math.round(edge * 16 / 9),
    main_url: APP_MEDIA_HOST + '/e2e-app/' + vid + '/' + edge + '.mp4',
    backup_url_list: [APP_MEDIA_HOST.replace('v3-', 'v6-') + '/e2e-app/' + vid + '/' + edge + '.mp4'],
    encrypt_info: { spade_a: spadeFor(APP_KEY), encrypt: true },
  }));
  return JSON.stringify({ code: 0, data: { [vid]: { video_model: JSON.stringify({ video_id: 'e2e' + vid, video_duration: 30, video_list }) } } });
}

/**
 * Route `page`'s App playback lookups: the live answer when it holds anything, else the
 * stand-in (and its media). `used` collects 'live' / 'stand-in' per lookup; `mutate(body)`
 * may rewrite an answer before the app sees it.
 */
export async function routeAppPlayback(page, { used = [], mutate = body => body } = {}) {
  const streams = appStreams();
  await page.route(APP_PLAYBACK, async route => {
    let response = null; let body = '';
    try { response = await route.fetch(); body = await response.text(); } catch (_) { /* answered below */ }
    const live = !!body.trim();
    used.push(live ? 'live' : 'stand-in');
    if (!live) body = appAnswer(askedVid(route.request()));
    body = mutate(body);
    return live ? route.fulfill({ response, body }) : route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.route(/-e2e\.qznovelvod\.com\/e2e-app\//, async route => {
    const edge = /\/(\d+)\.mp4/.exec(route.request().url())[1];
    // A real episode takes a moment to arrive; the player shows its progress meanwhile.
    await new Promise(resolve => setTimeout(resolve, 1500));
    return route.fulfill({ status: 200, contentType: 'video/mp4', body: streams[edge] }).catch(() => {});
  });
  return used;
}
