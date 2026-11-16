// Shared parsing helpers for the source adapters. Remote pages are only parsed as data;
// no script received from a source is ever executed.

export function plainText(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim();
}

// Upstream 7.3: an address a source hands back must point at the public internet. A literal
// private, loopback, link-local or reserved IP, a single-label host or a home-network name
// (router.lan, nas.local) is never a cover or a video, so it is not requested from the TV's
// network. Only the address as written is judged; nothing is resolved.
const BLOCKED_V4 = [
  [0, 0, 8], [10, 0, 8], [100, 64, 10], [127, 0, 8], [169, 254, 16], [172, 16, 12], [192, 0, 24, 0],
  [192, 0, 24, 2], [192, 168, 16], [198, 18, 15], [198, 51, 24, 100], [203, 0, 24, 113], [224, 0, 3],
];
function publicV4(a, b, c) {
  return !BLOCKED_V4.some(([first, second, prefix, third]) => {
    if (prefix <= 8) return (a >> (8 - prefix)) === (first >> (8 - prefix));
    if (a !== first) return false;
    if (prefix <= 16) return (b >> (16 - prefix)) === (second >> (16 - prefix));
    return b === second && c === third;
  });
}
function v6Groups(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const read = part => (part ? part.split(':') : []);
  const head = read(halves[0]), tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = head.concat(new Array(halves.length === 2 ? missing : 0).fill('0'), tail);
  return groups.every(group => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map(group => parseInt(group, 16)) : null;
}
function publicV6(host) {
  const g = v6Groups(host);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d): judged as the IPv4 address it carries.
  if (!g[0] && !g[1] && !g[2] && !g[3] && !g[4] && g[5] === 0xffff) return publicV4(g[6] >> 8, g[6] & 255, g[7] >> 8);
  // Global unicast only (2000::/3), minus documentation, Teredo and 6to4.
  return (g[0] >> 13) === 1 && !(g[0] === 0x2001 && (g[1] === 0xdb8 || g[1] === 0)) && g[0] !== 0x2002;
}

export function isPublicMediaUrl(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host.indexOf(':') >= 0) return publicV6(host);
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) return publicV4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
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
