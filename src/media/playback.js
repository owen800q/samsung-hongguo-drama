// Turns an episode into something the TV's <video> can play. Clear MP4 links play
// directly; CENC-encrypted App sources are downloaded and decrypted in memory, then
// written to a temp file on the TV (Tizen will not play blob: MP4s) or served from a
// Blob URL elsewhere. Only a couple of decrypted episodes are kept to bound memory.
import { getPlayInfo } from '../sources/index.js';
import { request, CancelToken } from '../lib/http.js';
import { fromHex } from '../lib/bytes.js';
import { decryptMp4 } from './cenc.js';
import { canWriteMedia, writeTempMedia } from '../platform/tvfile.js';

const MAX_BLOBS = 2;
// A prefetch gives up on episodes larger than this, so warming the next episode never
// holds two oversized buffers on a memory-constrained TV. Playing an episode lifts it.
const PREFETCH_MAX_BYTES = 48 * 1024 * 1024;
const blobs = new Map(); // vid -> { url, size, used, meta, dispose }
const inflight = new Map(); // vid -> { promise, token, users }

function touchBlob(vid) {
  const entry = blobs.get(vid);
  if (entry) { blobs.delete(vid); entry.used = Date.now(); blobs.set(vid, entry); }
  return entry;
}

function evict(keep) {
  while (blobs.size > MAX_BLOBS) {
    const oldest = Array.from(blobs.keys()).find(k => k !== keep);
    if (oldest === undefined) break;
    release(oldest);
  }
}

/** Drop a cached decrypted episode and free its memory. */
export function release(vid) {
  const entry = blobs.get(String(vid));
  if (entry) {
    blobs.delete(String(vid));
    try { entry.dispose(); } catch (_) {}
  }
}

export function releaseAll() {
  Array.from(blobs.keys()).forEach(release);
}

async function prepareEncrypted(vid, info, token, onProgress) {
  const res = await request(info.url, {
    responseType: 'arraybuffer', timeout: 120000, cancel: token,
    onProgress: (loaded, total) => onProgress && onProgress('download', loaded, total),
  });
  const data = new Uint8Array(res.data);
  if (token.cancelled) throw new Error('已取消');
  // A connection cut mid-transfer can still "load"; a truncated file only fails later as a
  // confusing decrypt or decode error. Compressed responses report the encoded length.
  const expected = res.header && !res.header('content-encoding') ? Number(res.header('content-length')) || 0 : 0;
  if (expected && data.length !== expected) throw new Error('片源下载不完整，请重试');
  onProgress && onProgress('decrypt', 0, data.length);
  const clear = await decryptMp4(data, fromHex(info.contentKey), {
    cancel: token, onProgress: (done, total) => onProgress && onProgress('decrypt', done, total),
  });
  if (token.cancelled) throw new Error('已取消');
  let url, dispose;
  let file = null;
  if (canWriteMedia()) {
    onProgress && onProgress('store', 0, clear.length);
    // A blob is the fallback (e.g. the web simulator's mocked filesystem, or a full disk).
    try { file = await writeTempMedia('ep-' + vid.replace(/[^0-9A-Za-z]/g, '_') + '.mp4', clear); } catch (_) {}
  }
  if (file) {
    url = file.uri;
    dispose = file.remove;
  } else {
    url = URL.createObjectURL(new Blob([clear], { type: 'video/mp4' }));
    dispose = () => URL.revokeObjectURL(url);
  }
  if (token.cancelled) { dispose(); throw new Error('已取消'); }
  blobs.set(vid, { url, size: clear.length, used: Date.now(), meta: info, dispose });
  evict(vid);
  return url;
}

function result(src, info, encrypted, vid) {
  return {
    src,
    encrypted,
    codec: info.codec || '',
    quality: info.quality || '',
    source: info.source || '',
    // Encrypted blobs stay cached for quick re-entry; callers release() them explicitly
    // or rely on the LRU. revoke() frees it immediately.
    revoke: () => { if (encrypted) release(vid); },
  };
}

/**
 * resolvePlayback(vid, seriesId, { cancel, onProgress(phase, loaded, total) })
 * phase: 'fetch' (address lookup), 'download', 'decrypt'.
 */
export async function resolvePlayback(vid, seriesId, options = {}) {
  vid = String(vid);
  const onProgress = options.onProgress;
  const cached = touchBlob(vid);
  if (cached) return result(cached.url, cached.meta, true, vid);

  let job = inflight.get(vid);
  // A job already cancelled (e.g. a prefetch that hit its size cap) is only winding down.
  if (job && job.token.cancelled) job = null;
  if (!job) {
    const token = new CancelToken();
    job = { token, users: 0, maxBytes: options.prefetch ? PREFETCH_MAX_BYTES : Infinity };
    job.promise = (async () => {
      job.progress && job.progress('fetch', 0, 0);
      const info = await getPlayInfo(vid, seriesId);
      if (token.cancelled) throw new Error('已取消');
      if (!info.contentKey) return { src: info.url, info, encrypted: false };
      const url = await prepareEncrypted(vid, info, token, (p, l, t) => {
        if (p === 'download' && Math.max(l, t) > job.maxBytes) token.cancel();
        job.progress && job.progress(p, l, t);
      });
      return { src: url, info, encrypted: true };
    })().finally(() => { if (inflight.get(vid) === job) inflight.delete(vid); });
    inflight.set(vid, job);
  }
  job.users++;
  if (!options.prefetch) job.maxBytes = Infinity;
  if (onProgress) job.progress = onProgress;
  let unsubscribe = () => {};
  if (options.cancel) {
    unsubscribe = options.cancel.subscribe(() => {
      job.users--;
      if (job.users <= 0) job.token.cancel();
    });
  }
  try {
    const r = await job.promise;
    return result(r.src, r.info, r.encrypted, vid);
  } finally {
    unsubscribe();
    if (job.progress === onProgress) job.progress = null;
  }
}

/**
 * Warm up the next episode (address lookup, and download + decryption when needed).
 * Cancelling `cancel` abandons the work unless the player has started using it. Never throws.
 */
export function prefetch(vid, seriesId, cancel) {
  return resolvePlayback(vid, seriesId, { cancel, prefetch: true }).then(() => true, () => false);
}
