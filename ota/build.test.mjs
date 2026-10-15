import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitPage, writeUpdate, writeWidget } from './build.mjs';

const page = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>T</title><script defer src="./a.js"></script></head><body class="x"><div id="app"></div></body></html>';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ota-'));
  const dir = path.join(root, 'dist');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), page);
  await writeFile(path.join(dir, 'a.js'), 'run()');
  await writeFile(path.join(dir, 'assets', 'b.css'), 'body{}');
  await writeFile(path.join(dir, 'config.js'), 'local()');
  await writeFile(path.join(dir, 'config.xml'), '<widget/>');
  return { root, dir };
}

test('splitPage keeps what the loader writes after <base>', () => {
  assert.deepEqual(splitPage(page), { lang: 'zh', head: '<title>T</title><script defer src="./a.js"></script>', bodyAttrs: ' class="x"', body: '<div id="app"></div>' });
});

test('the widget and the Worker identify the same build alike', async () => {
  const { root, dir } = await fixture();
  const out = path.join(root, 'worker');
  const stage = path.join(root, 'widget');
  const opts = { dir, html: page, exclude: ['config.js'] };
  const id = await writeUpdate({ ...opts, out, headers: true });
  assert.equal(await writeWidget({ ...opts, stage, key: 'k', origin: 'https://w.example/', text: 'new', preHead: '<script src="config.js"></script>' }), id);

  const manifest = JSON.parse(await readFile(path.join(out, 'tv-app', 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, id);
  assert.deepEqual(manifest.files, [{ path: 'a.js', size: 5 }, { path: 'assets/b.css', size: 6 }]);
  assert.equal(await readFile(path.join(out, 'tv-app', 'v', id, 'assets', 'b.css'), 'utf8'), 'body{}');
  assert.match(await readFile(path.join(out, '_headers'), 'utf8'), /\/tv-app\/v\/\*\n  Cache-Control: public, max-age=31536000, immutable/);

  const html = await readFile(path.join(stage, 'index.html'), 'utf8');
  assert.match(html, /<html lang="zh">[\s\S]*<script src="config.js"><\/script>\s*<script src="ota-config.js"><\/script>\s*<script src="ota.js"><\/script>/);
  assert.equal(await readFile(path.join(stage, 'app', 'a.js'), 'utf8'), 'run()');
  const config = await readFile(path.join(stage, 'ota-config.js'), 'utf8');
  assert.match(config, /"manifest":"https:\/\/w.example\/tv-app\/manifest.json"/);
  assert.match(config, new RegExp('"id":"' + id + '"'));
});

test('a change to the page or a file changes the build id', async () => {
  const { root, dir } = await fixture();
  const a = await writeUpdate({ dir, html: page, out: path.join(root, 'a') });
  const b = await writeUpdate({ dir, html: page.replace('T', 'U'), out: path.join(root, 'b') });
  await writeFile(path.join(dir, 'a.js'), 'run2()');
  const c = await writeUpdate({ dir, html: page, out: path.join(root, 'c') });
  assert.equal(new Set([a, b, c]).size, 3);
});

test('the loader stays ES5 for Tizen 4.0 (Chromium 56)', async () => {
  const code = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ota.js'), 'utf8');
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.doesNotMatch(stripped, /=>|\blet\b|\bconst\b|`|\bclass\b/);
  new Function(code);
});
