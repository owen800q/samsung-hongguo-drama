// Temporary media files in the app's private temp folder. Tizen's media player will
// not play a plain MP4 from a blob: URL (only MSE streams), but it plays local files,
// so decrypted episodes are written here and played from their file:// URI.
// Returns null in desktop browsers, where blob: URLs are used instead.

const ROOT = 'wgt-private-tmp';
const CHUNK = 3 * 256 * 1024; // multiple of 3 so each base64 piece decodes on its own

function fs() {
  return typeof window !== 'undefined' && window.tizen && window.tizen.filesystem ? window.tizen.filesystem : null;
}

export function canWriteMedia() {
  return !!fs();
}

function toBase64(bytes, start, end) {
  let binary = '';
  for (let i = start; i < end; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 0x8000)));
  }
  return btoa(binary);
}

const yieldToUi = () => new Promise(r => setTimeout(r, 0));

// Tizen 5.0+: FileHandle API with binary writes.
async function writeModern(api, name, bytes) {
  const path = ROOT + '/' + name;
  const handle = api.openFile(path, 'w');
  try {
    for (let i = 0; i < bytes.length; i += CHUNK) {
      handle.writeData(bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
      await yieldToUi();
    }
  } finally {
    handle.close();
  }
  return {
    uri: api.toURI(path),
    remove: () => { try { api.deleteFile(path, () => {}, () => {}); } catch (_) {} },
  };
}

// Tizen 4.0: legacy File/FileStream API, which only writes text or base64.
function writeLegacy(api, name, bytes) {
  return new Promise((resolve, reject) => {
    api.resolve(ROOT, dir => {
      try {
        try { dir.deleteFile(dir.fullPath + '/' + name); } catch (_) {}
        const file = dir.createFile(name);
        file.openStream('w', async stream => {
          try {
            for (let i = 0; i < bytes.length; i += CHUNK) {
              stream.writeBase64(toBase64(bytes, i, Math.min(bytes.length, i + CHUNK)));
              await yieldToUi();
            }
            stream.close();
            resolve({
              uri: file.toURI(),
              remove: () => { try { dir.deleteFile(file.fullPath, () => {}, () => {}); } catch (_) {} },
            });
          } catch (e) {
            try { stream.close(); } catch (_) {}
            reject(e);
          }
        }, reject, 'UTF-8');
      } catch (e) {
        reject(e);
      }
    }, reject, 'rw');
  });
}

/** Write bytes to a temp file; resolves { uri, remove() }. */
export function writeTempMedia(name, bytes) {
  const api = fs();
  if (!api) return Promise.reject(new Error('当前环境不支持本地缓存'));
  return typeof api.openFile === 'function' ? writeModern(api, name, bytes) : writeLegacy(api, name, bytes);
}
