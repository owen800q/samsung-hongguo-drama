import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ota.js', import.meta.url), 'utf8');

// Run the loader with a given widget config and stored OTA state; report which
// build it wrote into the page and what it left in storage.
function launch(config, stored, store = new Map()) {
  if (stored) store.set('__ota:' + config.key, JSON.stringify(stored));
  let written = '';
  const listeners = {};
  const timers = [];
  const shown = [];
  const window = {
    __OTA_CONFIG__: config,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const body = { appendChild(el) { el.parentNode = body; shown.push(el); }, removeChild() {} };
  const context = {
    window,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    document: {
      write: html => { written += html; }, addEventListener() {}, getElementsByTagName: () => [],
      body, createElement: () => ({ style: {} }),
    },
    navigator: { onLine: true },
    location: { reload() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
  };
  vm.runInNewContext(source, context);
  const state = () => JSON.parse(store.get('__ota:' + config.key) || '{}');
  // Fire the page's load event and the timers it starts, short of the update check.
  const load = () => {
    for (const fn of listeners.load || []) fn();
    for (const t of timers.splice(0)) if (t.ms < 10000) t.fn();
  };
  return { base: (written.match(/<base href="([^"]*)">/) || [])[1], ota: window.__ota, state: state(), store, load, shown, timers, context };
}

const bundled = { key: 'bilibili', id: 'own', head: '', body: '', bodyAttrs: '', text: '' };
const downloaded = { id: 'cloud', base: 'https://w.example/tv-app/v/cloud/', head: '', body: '', bodyAttrs: '', files: [] };

test('an updatable widget runs the build a previous launch downloaded', () => {
  const r = launch({ ...bundled, manifest: 'https://w.example/tv-app/manifest.json' }, { ready: downloaded });
  assert.equal(r.base, downloaded.base);
  assert.equal(r.ota.remote, true);
});

test('a widget packaged without updates runs its own build, even with a download left by an earlier install', () => {
  const r = launch({ ...bundled, manifest: null }, { ready: downloaded });
  assert.equal(r.base, 'app/');
  assert.equal(r.ota.remote, false);
  assert.equal(r.state.ready, null);
});

const updatable = { ...bundled, manifest: 'https://w.example/tv-app/manifest.json', text: 'downloaded', updated: 'updated' };

test('the first launch of a downloaded build says the app was updated, later launches do not', () => {
  const first = launch(updatable, { ready: downloaded });
  first.load();
  assert.deepEqual(first.shown.map(el => el.textContent), ['updated']);
  const second = launch(updatable, null, first.store);
  second.load();
  assert.deepEqual(second.shown, []);
});

test('the bundled build shows no update notice', () => {
  const r = launch(updatable, null);
  r.load();
  assert.deepEqual(r.shown, []);
});

test('a notice stays on screen for 15 seconds', () => {
  const r = launch(updatable, { ready: downloaded });
  r.load();
  const removal = r.timers.find(t => t.ms >= 6000 && t.ms < 60000);
  assert.equal(removal && removal.ms, 15000);
});
