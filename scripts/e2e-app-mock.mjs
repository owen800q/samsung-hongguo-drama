// A stand-in for the 红果 App's playback endpoints in the e2e run. Since November 2026 the
// live ones answer every anonymous device with an empty body, so the checks that follow an
// App stream through the player (address fallback, decryption, stream swap) get a model
// here whose streams are test clips encrypted the way the App's are: full-sample CENC
// (AES-CTR, 8-byte IVs in a senc box), key in spade_a. Device registration and the series
// detail endpoint stay live.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const KEY = '0123456789abcdef0123456789abcdef';
const KID = '00112233445566778899aabbccddeeff';
// Playback lookups, not the detail (episode list) request on the same host.
export const APP_PLAYBACK = /^https:\/\/(?:api5-normal[^/]*\.fqnovel\.com|reading\.snssdk\.com)\/(?!novel\/player\/video_detail\/)/;
export const APP_MEDIA = /qznovelvod\.com\/e2e-app\/(h264|hevc)-(\d+)\/(main|backup)\.mp4/;

// Inverse of deriveContentKey in src/sources/app-source.js.
function spadeFor(hex) {
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

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const children = (data, start, end) => {
  const out = [];
  for (let off = start; off + 8 <= end;) {
    const size = data.readUInt32BE(off);
    if (size < 8 || off + size > end) throw new Error('unexpected MP4 box layout');
    out.push({ type: data.toString('latin1', off + 4, off + 8), off, size });
    off += size;
  }
  return out;
};

/** A clear MP4 whose moov follows its mdat → the same file with every sample encrypted. */
export function encryptMp4(clear, keyHex = KEY) {
  const data = Buffer.from(clear);
  const top = children(data, 0, data.length);
  const moov = top[top.length - 1];
  if (!moov || moov.type !== 'moov') throw new Error('the clip must end with its moov box');
  const key = Buffer.from(keyHex, 'hex');
  const rebuild = (node, trail) => {
    const kids = children(data, node.off + 8, node.off + node.size);
    const parts = kids.map(kid => {
      if (['trak', 'mdia', 'minf', 'stbl'].indexOf(kid.type) >= 0) return rebuild(kid, trail.concat(kid.type));
      if (kid.type !== 'stsd') return data.subarray(kid.off, kid.off + kid.size);
      // One sample entry per track: rename it and say what it was.
      const entry = kid.off + 16;
      const size = data.readUInt32BE(entry);
      const original = data.toString('latin1', entry + 4, entry + 8);
      const video = ['avc1', 'hvc1', 'hev1'].indexOf(original) >= 0;
      const sinf = box('sinf', box('frma', Buffer.from(original, 'latin1')),
        box('schm', Buffer.from('00000000' + Buffer.from('cenc').toString('hex') + '00010000', 'hex')),
        box('schi', box('tenc', Buffer.from('00000000' + '0000' + '01' + '08' + KID, 'hex'))));
      const head = Buffer.alloc(8);
      head.writeUInt32BE(size + sinf.length, 0);
      head.write(video ? 'encv' : 'enca', 4, 'latin1');
      return box('stsd', data.subarray(kid.off + 8, kid.off + 16), head, data.subarray(entry + 8, entry + size), sinf);
    });
    if (node.type === 'stbl') {
      const find = type => kids.find(kid => kid.type === type);
      const stsz = find('stsz'); const stco = find('stco'); const stsc = find('stsc');
      const fixed = data.readUInt32BE(stsz.off + 12);
      const count = data.readUInt32BE(stsz.off + 16);
      const chunks = data.readUInt32BE(stco.off + 12);
      const runs = [];
      for (let i = 0; i < data.readUInt32BE(stsc.off + 12); i++) runs.push([data.readUInt32BE(stsc.off + 16 + i * 12), data.readUInt32BE(stsc.off + 20 + i * 12)]);
      const ivs = [];
      let sample = 0;
      for (let c = 0; c < chunks; c++) {
        const run = runs.filter(r => r[0] <= c + 1).pop();
        let off = data.readUInt32BE(stco.off + 16 + c * 4);
        for (let s = 0; s < run[1] && sample < count; s++, sample++) {
          const size = fixed || data.readUInt32BE(stsz.off + 20 + sample * 4);
          const iv = crypto.randomBytes(8);
          const cipher = crypto.createCipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
          cipher.update(data.subarray(off, off + size)).copy(data, off);
          ivs.push(iv);
          off += size;
        }
      }
      const head = Buffer.alloc(8);
      head.writeUInt32BE(ivs.length, 4);
      parts.push(box('senc', head, ...ivs));
    }
    return box(node.type, ...parts);
  };
  // The moov is last, so growing it moves no sample.
  const encrypted = rebuild(moov, []);
  return Buffer.concat([data.subarray(0, moov.off), encrypted]);
}

const clips = {};
/** A 20 s encrypted test clip (360 x 640, with sound) in `codec`: 'h264' or 'hevc'. */
export function encryptedClip(codec) {
  if (clips[codec]) return clips[codec];
  const file = path.join(os.tmpdir(), 'hgtv-e2e-clear-' + codec + '.mp4');
  if (!fs.existsSync(file)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '20', '-c:v', codec === 'hevc' ? 'libx265' : 'libx264', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-b:v', '200k',
      '-tag:v', codec === 'hevc' ? 'hvc1' : 'avc1', '-c:a', 'aac', '-map_metadata', '-1', file]);
  }
  return (clips[codec] = encryptMp4(fs.readFileSync(file)));
}

function requestedVid(request) {
  const body = request.postDataBuffer();
  if (!body) return new URL(request.url()).searchParams.get('video_id') || '';
  const json = JSON.parse(zlib.gunzipSync(body).toString());
  return String(json.video_id || json.mixed_video_id_map[1004][0]);
}

/**
 * Answers the App's playback lookups on `page` with a model listing `streams` (best first,
 * `{ codec: 'h264' | 'hevc', edge }`), each with a main and a backup address serving an
 * encrypted clip. `failFirstMedia` answers the first media request with HTTP 404; `mediaDelay`
 * holds every clip back that many ms, as a real download would take.
 * Returns what was asked: `lookups` (episode ids) and `media` (addresses, in order).
 */
export async function mockAppPlayback(page, { streams = [{ codec: 'hevc', edge: 1080 }, { codec: 'h264', edge: 720 }], failFirstMedia = false, mediaDelay = 0 } = {}) {
  const seen = { lookups: [], media: [] };
  const spade = spadeFor(KEY);
  await page.route(APP_PLAYBACK, route => {
    let vid = '';
    try { vid = requestedVid(route.request()); } catch (_) { /* answered as an empty body */ }
    if (!vid) return route.fulfill({ status: 200, contentType: 'application/json', body: '' });
    seen.lookups.push(vid);
    const list = {};
    streams.forEach((s, i) => {
      const base = 'https://v' + (i + 1) + '.qznovelvod.com/e2e-app/' + s.codec + '-' + s.edge + '/';
      list['video_' + (i + 1)] = { codec_type: s.codec === 'hevc' ? 'bytevc1' : 'h264', definition: s.edge + 'p', vwidth: s.edge, vheight: Math.round(s.edge * 16 / 9),
        main_url: base + 'main.mp4', backup_url_list: [base + 'backup.mp4'], spade_a: spade };
    });
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { [vid]: { video_model: JSON.stringify({ video_id: 'e2e' + vid, video_duration: 20, video_list: list }) } } }) });
  });
  let failed = !failFirstMedia;
  await page.route(APP_MEDIA, async route => {
    seen.media.push(route.request().url().split('?')[0]);
    if (!failed) { failed = true; return route.fulfill({ status: 404, body: '' }); }
    if (mediaDelay) await new Promise(resolve => setTimeout(resolve, mediaDelay));
    return route.fulfill({ status: 200, contentType: 'video/mp4', body: encryptedClip(APP_MEDIA.exec(route.request().url())[1]) }).catch(() => {});
  });
  return seen;
}
