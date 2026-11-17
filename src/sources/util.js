// Shared parsing helpers for the source adapters. Remote pages are only parsed as data;
// no script received from a source is ever executed.

export function plainText(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim();
}

// Reserved, private, loopback, link-local, documentation and multicast IPv4 ranges.
const PRIVATE_V4 = [[0, 0, 8], [10, 0, 8], [100, 64, 10], [127, 0, 8], [169, 254, 16], [172, 16, 12], [192, 0, 24, 0],
  [192, 0, 24, 2], [192, 168, 16], [198, 18, 15], [198, 51, 24, 100], [203, 0, 24, 113], [224, 0, 3]];

/**
 * Upstream 7.3: an address a source hands out for a cover or a video has to point at the
 * public internet, not at this TV or the home network around it. Only the address as
 * written is judged (a TV app cannot see what a name resolves to).
 */
export function isPublicMediaUrl(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host.indexOf(':') >= 0) {
      // IPv6: global unicast only, without the documentation, Teredo and 6to4 ranges.
      const first = parseInt(host.split(':')[0] || '0', 16);
      const second = parseInt(host.split(':')[1] || '0', 16);
      return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second === 0 || second === 0xdb8));
    }
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
      const n = v4.slice(1).map(Number);
      if (n.some(part => part > 255)) return false;
      const address = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
      return !PRIVATE_V4.some(range => {
        const base = ((range[0] << 24) | (range[1] << 16) | ((range[3] || 0) << 8)) >>> 0;
        return (address >>> (32 - range[2])) === (base >>> (32 - range[2]));
      });
    }
    // A number that is not a dotted quad is still an address to the TV (e.g. 2130706433).
    if (/^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return false;
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
