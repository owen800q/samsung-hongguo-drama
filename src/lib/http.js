// Network layer. On the TV, the Tizen runtime allows cross-origin requests to the
// origins whitelisted in config.xml, so requests go straight to the source. In a
// desktop browser (dev), requests are relayed through the Vite dev server.
// Browsers silently drop forbidden headers (User-Agent, Referer, Origin, Cookie);
// every source used here was verified to work without them.

export function isTV() {
  return typeof window !== 'undefined' && (typeof window.tizen !== 'undefined' || !/^https?:$/.test(window.location.protocol));
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class CancelToken {
  constructor() {
    this.cancelled = false;
    this.listeners = [];
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.listeners.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
  }
  subscribe(fn) {
    if (this.cancelled) fn();
    else this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(x => x !== fn); };
  }
}

function proxied(url) {
  if (isTV() || typeof window === 'undefined') return url;
  return '/__proxy?u=' + encodeURIComponent(url);
}

function xhrTransport(url, options) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || 'GET', proxied(url), true);
    xhr.timeout = options.timeout || 15000;
    xhr.responseType = options.responseType === 'arraybuffer' ? 'arraybuffer' : 'text';
    const headers = options.headers || {};
    Object.keys(headers).forEach(key => { try { xhr.setRequestHeader(key, headers[key]); } catch (_) {} });
    let unsubscribe = () => {};
    const done = (fn, value) => { unsubscribe(); fn(value); };
    xhr.onload = () => done(resolve, {
      status: xhr.status,
      data: xhr.response,
      url: xhr.getResponseHeader('x-final-url') || xhr.responseURL || url,
      header: name => xhr.getResponseHeader(name),
    });
    xhr.onerror = () => done(reject, new HttpError('网络连接失败', 0));
    xhr.ontimeout = () => done(reject, new HttpError('请求超时', 0));
    xhr.onabort = () => done(reject, new HttpError('已取消', -1));
    if (options.onProgress) xhr.onprogress = e => options.onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    if (options.cancel) unsubscribe = options.cancel.subscribe(() => xhr.abort());
    xhr.send(options.body == null ? null : options.body);
  });
}

let transport = xhrTransport;

/** Tests replace the transport (Node has no XMLHttpRequest). */
export function setTransport(fn) {
  transport = fn || xhrTransport;
}

/**
 * request(url, { method, headers, body, responseType: 'text'|'json'|'arraybuffer', timeout, cancel, onProgress })
 * Resolves { status, data, url, header(name) }; rejects on network failure or non-2xx.
 */
export async function request(url, options = {}) {
  if (options.cancel && options.cancel.cancelled) throw new HttpError('已取消', -1);
  const res = await transport(url, options);
  if (res.status < 200 || res.status >= 300) throw new HttpError('HTTP ' + res.status, res.status);
  if (options.responseType === 'json') {
    let data = res.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { throw new HttpError('响应不是有效的 JSON', res.status); }
    }
    return Object.assign({}, res, { data });
  }
  return res;
}

export function getText(url, options = {}) {
  return request(url, Object.assign({}, options, { responseType: 'text' })).then(r => r.data);
}

export function getJson(url, options = {}) {
  return request(url, Object.assign({}, options, { responseType: 'json' })).then(r => r.data);
}

export function withQuery(url, params) {
  const pairs = Object.keys(params || {}).filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  return pairs.length ? url + (url.indexOf('?') >= 0 ? '&' : '?') + pairs.join('&') : url;
}

/** Short-lived memo: identical in-flight requests share one promise; failures are not cached. */
export function memo(ttl, maxSize = 64) {
  const cache = new Map();
  const pending = new Map();
  return function cached(key, load, force) {
    const hit = cache.get(key);
    if (!force && hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    const p = Promise.resolve().then(load).then(value => {
      cache.set(key, { value, expires: Date.now() + ttl });
      if (cache.size > maxSize) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
}
