// Shared parsing helpers for the source adapters. Remote pages are only parsed as data;
// no script received from a source is ever executed.

export function plainText(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim();
}

function publicV4(parts) {
  const a = parts[0], b = parts[1], c = parts[2];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

/**
 * Upstream 7.3: every source's media and cover address must point at the public internet.
 * Loopback, private, link-local, reserved and Fake-IP literals and local names (localhost,
 * *.local, *.lan, ...) are refused. A TV cannot check what a name resolves to, so this is
 * the address as written; URL() has already normalised forms such as 0x7f.1 or 2130706433.
 */
export function isPublicMediaUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host.indexOf(':') >= 0) {
      const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (mapped) {
        const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
        return publicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
      }
      const dotted = host.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (dotted) return publicV4(dotted.slice(1).map(Number));
      const groups = host.split(':');
      const first = parseInt(groups[0], 16);
      // Global unicast only (2000::/3), minus documentation, Teredo and 6to4.
      if (!(first >= 0x2000 && first <= 0x3fff) || first === 0x2002) return false;
      return !(first === 0x2001 && (groups[1] === 'db8' || groups[1] === '' || groups[1] === '0'));
    }
    if (/^[\d.]+$/.test(host)) {
      const parts = host.split('.').map(Number);
      return parts.length === 4 && parts.every(n => n >= 0 && n <= 255) && publicV4(parts);
    }
    return host.indexOf('.') >= 0 && !/(^|\.)(localhost|local|internal|lan|home)$/.test(host);
  } catch (_) { return false; }
}

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && isPublicMediaUrl(url.href) ? url.href : '';
  } catch (_) { return ''; }
}

export function decodeHtml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (entity, key) => {
    if (key[0] !== '#') return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[key.toLowerCase()];
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** Extract the JSON object assigned to window._ROUTER_DATA without executing the page. */
export function readRouterData(html) {
  const text = String(html);
  const match = text.match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw new Error('来源页面未返回数据，请稍后重试');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('来源页面数据不完整，请重试');
}

export function uniqueBy(list, key) {
  const seen = new Set();
  return list.filter(item => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function friendlyError(error, fallback) {
  const msg = error && error.message;
  if (msg === '请求超时') return fallback.replace(/暂不可用.*$/, '加载超时，请重试');
  return fallback;
}
