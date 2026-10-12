// Shared parsing helpers for the source adapters. Remote pages are only parsed as data;
// no script received from a source is ever executed.

export function plainText(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim();
}

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
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
