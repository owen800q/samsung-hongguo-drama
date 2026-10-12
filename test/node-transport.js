// Node stand-in for the TV's XHR: same request shape, TV user agent, no Referer.
import { setTransport } from '../src/lib/http.js';

const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';
const FORBIDDEN = ['user-agent', 'referer', 'origin', 'cookie', 'host'];

export function useNodeTransport() {
  setTransport(async (url, options) => {
    const headers = { 'user-agent': TV_UA };
    Object.keys(options.headers || {}).forEach(k => { if (FORBIDDEN.indexOf(k.toLowerCase()) < 0) headers[k] = options.headers[k]; });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeout || 15000);
    try {
      const res = await fetch(url, { method: options.method || 'GET', headers, body: options.body == null ? undefined : options.body, signal: ctrl.signal });
      const data = options.responseType === 'arraybuffer' ? await res.arrayBuffer() : await res.text();
      return { status: res.status, data, url: res.url, header: n => res.headers.get(n) };
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? '请求超时' : '网络连接失败');
    } finally { clearTimeout(timer); }
  });
}
