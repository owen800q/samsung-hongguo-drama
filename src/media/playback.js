// Turns an episode into something the TV's <video> can play. Clear MP4 links play
// directly; CENC-encrypted App sources are downloaded and decrypted in memory, then
// written to a temp file on the TV (Tizen will not play blob: MP4s) or served from a
// Blob URL elsewhere. Only a couple of decrypted episodes are kept to bound memory.
import { getPlayInfo } from '../sources/index.js';
import { request, CancelToken, HttpError } from '../lib/http.js';
import { fromHex } from '../lib/bytes.js';
import { decryptMp4 } from './cenc.js';
import { canWriteMedia, writeTempMedia } from '../platform/tvfile.js';

const MAX_BLOBS = 2;
// A prefetch gives up on episodes larger than this, so warming the next episode never
// holds two oversized buffers on a memory-constrained TV. Playing an episode lifts it.
const PREFETCH_MAX_BYTES = 48 * 1024 * 1024;
// A whole episode is held in memory (download, then decryption) before it can play. An
// abnormally large file would exhaust the TV's memory, so playing gives up past this.
let playMaxBytes = 300 * 1024 * 1024;
const blobs = new Map(); // vid -> { url, size, used, meta, quality, dispose }
const inflight = new Map(); // vid -> { promise, token, users }
let fileSeq = 0;

function touchBlob(vid, quality) {
  let entry = blobs.get(vid);
  // An episode decrypted at another quality setting is not what the viewer chose now.
  if (entry && entry.quality !== quality) { release(vid); entry = null; }
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

/** Tests lower the in-memory size limit for playing. */
export function setPlayMaxBytes(bytes) {
  playMaxBytes = bytes || 300 * 1024 * 1024;
}

function tooLarge(quality) {
  const hint = quality === '720p' ? '请换一个片源' : '可在设置中把红果清晰度改为 720P 后重试';
  return Object.assign(new Error('本集文件过大，电视内存放不下，' + hint), { code: 'MEDIA_TOO_LARGE' });
}

async function prepareEncrypted(vid, info, quality, token, onProgress) {
  // Its own token, so an oversized address is abandoned without cancelling the whole job.
  const transfer = new CancelToken();
  const unsubscribe = token.subscribe(() => transfer.cancel());
  let oversized = false;
  let res;
  try {
    res = await request(info.url, {
      responseType: 'arraybuffer', timeout: 120000, cancel: transfer,
      onProgress: (loaded, total) => {
        onProgress && onProgress('download', loaded, total);
        if (Math.max(loaded, total) > playMaxBytes && !token.cancelled) { oversized = true; transfer.cancel(); }
      },
    });
  } catch (error) {
    throw oversized && !token.cancelled ? tooLarge(quality) : error;
  } finally {
    unsubscribe();
  }
  const data = new Uint8Array(res.data);
  if (token.cancelled) throw new Error('已取消');
  if (data.length > playMaxBytes) throw tooLarge(quality);
  // An expired address can answer 200 with an error page instead of the video.
  const type = res.header ? res.header('content-type') || '' : '';
  if (/text\/html|application\/json/i.test(type)) throw new Error('片源返回了错误页面，请重新获取片源');
  // A connection cut mid-transfer can still "load"; a truncated file only fails later as a
  // confusing decrypt or decode error. Compressed responses report the encoded length.
  const expected = res.header && !res.header('content-encoding') ? Number(res.header('content-length')) || 0 : 0;
  if (!data.length || (expected && data.length !== expected)) throw new Error('片源下载不完整，请重试');
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
    // Unique per write, so an abandoned job cleaning up never deletes a newer job's file.
    try { file = await writeTempMedia('ep-' + vid.replace(/[^0-9A-Za-z]/g, '_') + '-' + (++fileSeq) + '.mp4', clear); } catch (_) {}
  }
  if (file) {
    url = file.uri;
    dispose = file.remove;
  } else {
    url = URL.createObjectURL(new Blob([clear], { type: 'video/mp4' }));
    dispose = () => URL.revokeObjectURL(url);
  }
  if (token.cancelled) { dispose(); throw new Error('已取消'); }
  release(vid);
  blobs.set(vid, { url, size: clear.length, used: Date.now(), meta: info, quality, dispose });
  evict(vid);
  return url;
}

// A failed download moves on to the episode's next address (a backup, or the next
// quality down), at most this many in total.
const MAX_TRANSFERS = 3;

function encryptedCandidates(info) {
  const list = [info].concat(info.variants || []).filter(v => v && v.url && v.contentKey);
  const seen = {};
  return list.filter(v => {
    const identity = v.url + ':' + v.contentKey;
    if (seen[identity]) return false;
    return (seen[identity] = true);
  }).slice(0, MAX_TRANSFERS);
}

// Errors from fetching the media itself, where another address (perhaps a smaller one) may
// succeed. A timeout usually means a slow network, which another address would not fix.
function isTransferFailure(error) {
  if (error instanceof HttpError) return error.status > 0 || error.message === '网络连接失败';
  if (error && error.code === 'MEDIA_TOO_LARGE') return true;
  return /片源返回了错误页面|片源下载不完整/.test(String(error && error.message));
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
 * resolvePlayback(vid, seriesId, { cancel, onProgress(phase, loaded, total), force, quality })
 * phase: 'fetch' (address lookup), 'download', 'decrypt'. `quality` is the 红果 setting
 * ('auto', '720p', '1080p'); other sources ignore it.
 * `force` reconnects: it drops the cached episode and any in-flight work, and looks the
 * address up again.
 */
export async function resolvePlayback(vid, seriesId, options = {}) {
  vid = String(vid);
  const onProgress = options.onProgress;
  const force = !!options.force;
  const quality = options.quality || 'auto';
  if (force) release(vid);
  const cached = touchBlob(vid, quality);
  if (cached) return result(cached.url, cached.meta, true, vid);

  let job = inflight.get(vid);
  // Reconnecting abandons work that was started with the old address.
  if (job && ((force && !job.force) || job.quality !== quality)) job.token.cancel();
  // A job already cancelled (e.g. a prefetch that hit its size cap) is only winding down.
  if (job && job.token.cancelled) job = null;
  if (!job) {
    const token = new CancelToken();
    job = { token, users: 0, force, quality, maxBytes: options.prefetch ? PREFETCH_MAX_BYTES : Infinity };
    job.promise = (async () => {
      job.progress && job.progress('fetch', 0, 0);
      const info = await getPlayInfo(vid, seriesId, { force, quality });
      if (token.cancelled) throw new Error('已取消');
      if (!info.contentKey) return { src: info.url, info, encrypted: false };
      const candidates = encryptedCandidates(info);
      let firstError = null;
      for (let i = 0; i < candidates.length; i++) {
        try {
          const url = await prepareEncrypted(vid, candidates[i], quality, token, (p, l, t) => {
            if (p === 'download' && Math.max(l, t) > job.maxBytes) token.cancel();
            job.progress && job.progress(p, l, t);
          });
          return { src: url, info: candidates[i], encrypted: true };
        } catch (error) {
          if (token.cancelled || !isTransferFailure(error)) throw error;
          // Being too large is what the viewer can act on (a lower quality), so it is reported first.
          if (!firstError || (error.code === 'MEDIA_TOO_LARGE' && firstError.code !== 'MEDIA_TOO_LARGE')) firstError = error;
        }
      }
      throw firstError;
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
export function prefetch(vid, seriesId, cancel, quality) {
  return resolvePlayback(vid, seriesId, { cancel, prefetch: true, quality }).then(() => true, () => false);
}
