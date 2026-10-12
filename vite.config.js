import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Tizen's web runtime lets a packaged app reach any origin listed in config.xml,
// so the TV build calls the sources directly. Desktop browsers enforce CORS, so
// the dev server relays those requests and mimics a Samsung TV user agent.
const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';
const SKIP_REQUEST = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'accept-encoding', 'user-agent']);
const SKIP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'access-control-allow-origin']);

function devProxy() {
  // Also mounted on `vite preview`, so the production bundle can be checked in old browsers.
  const mount = server => { server.middlewares.use('/__proxy', relay); };
  return { name: 'tv-dev-proxy', configureServer: mount, configurePreviewServer: mount };
}

async function relay(req, res) {
  try {
    const target = new URL(new URL(req.url, 'http://local').searchParams.get('u'));
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
    const headers = { 'user-agent': TV_UA };
    for (const [key, value] of Object.entries(req.headers)) if (!SKIP_REQUEST.has(key)) headers[key] = value;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(target, {
      method: req.method, headers, redirect: 'follow',
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => { if (!SKIP_RESPONSE.has(key)) res.setHeader(key, value); });
    const length = upstream.headers.get('content-length');
    if (length && !upstream.headers.get('content-encoding')) res.setHeader('content-length', length);
    res.setHeader('x-final-url', upstream.url);
    res.setHeader('access-control-expose-headers', '*');
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.statusCode = 502;
    res.end(String(error && error.message));
  }
}

// Chromium 56 (Tizen 4.0) predates module scripts: ship one classic IIFE bundle.
function classicScript() {
  return {
    name: 'tv-classic-script',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" ');
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [devProxy(), classicScript()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  esbuild: { jsxFactory: 'h', jsxFragment: 'Fragment', jsxInject: "import { h, Fragment } from 'preact'" },
  build: {
    // 2018+ Samsung TVs ship Chromium 56 or newer in the Tizen web runtime.
    target: 'chrome56',
    cssTarget: 'chrome56',
    modulePreload: false,
    assetsInlineLimit: 0,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
  server: { host: true, port: 5180 },
});
