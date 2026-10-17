// Build-time half of the over-the-air updates (runtime: ota/ota.js).
//   writeUpdate(): the Worker's copy, served at /tv-app/manifest.json and /tv-app/v/<id>/…
//   writeWidget(): the packaged widget, a loader index.html with the same build under app/.
// Both identify a build by a hash of its files and page markup, so a TV running the
// build in its widget does not download it again.
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// Widget and Worker files that sit next to a build but are not part of it.
const SKIP = new Set(['index.html', 'config.xml', 'icon.png', 'tv-app', '_headers', '_routes.json', '_redirects']);

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of (await readdir(path.join(dir, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.name.startsWith('.') || (!prefix && SKIP.has(entry.name))) continue;
    if (entry.isDirectory()) out.push(...await listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

// Splits a page into what the loader writes after <base>: the <head> content without
// <meta charset> (the loader has it), the <body> attributes and the <body> content.
export function splitPage(html) {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const body = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
  if (!head || !body) throw new Error('page has no <head> or <body>');
  return {
    lang: (/<html[^>]*\slang="([^"]*)"/i.exec(html) || [])[1] || '',
    head: head[1].replace(/<meta\s+charset[^>]*>\s*/i, '').trim(),
    bodyAttrs: body[1],
    body: body[2].trim(),
  };
}

async function describe(dir, html, exclude) {
  const page = splitPage(html);
  const files = [];
  const hash = createHash('sha256').update(JSON.stringify([page.head, page.bodyAttrs, page.body]));
  for (const rel of await listFiles(dir)) {
    if (exclude.includes(rel)) continue;
    const data = await readFile(path.join(dir, rel));
    hash.update(rel).update('\0').update(data);
    files.push({ path: rel, size: data.length });
  }
  return { id: hash.digest('hex').slice(0, 16), page, files };
}

async function copyFiles(dir, files, target) {
  for (const { path: rel } of files) {
    await mkdir(path.dirname(path.join(target, rel)), { recursive: true });
    await cp(path.join(dir, rel), path.join(target, rel));
  }
}

// dir: the built app; html: its page as the TV should load it; exclude: files of dir that
// stay out of the build (kept in the widget by preHead below); out: the Worker's assets
// directory; headers: append HEADERS to out/_headers (for assets that do not list them already).
export async function writeUpdate({ dir, html, exclude = [], out, headers = false }) {
  const { id, page, files } = await describe(dir, html, exclude);
  const target = path.join(out, 'tv-app');
  await rm(target, { recursive: true, force: true });
  await copyFiles(dir, files, path.join(target, 'v', id));
  const manifest = { id, head: page.head, bodyAttrs: page.bodyAttrs, body: page.body, files };
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest));
  if (headers) await appendFile(path.join(out, '_headers'), HEADERS);
  return id;
}

// Headers for the files writeUpdate() produces, in the Worker's _headers format.
export const HEADERS = `
# Over-the-air TV app updates (ota/build.mjs): builds are immutable, the manifest is always revalidated.
/tv-app/v/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
/tv-app/manifest.json
  Cache-Control: no-cache
  Access-Control-Allow-Origin: *
`;

// stage: the widget directory being packaged. origin: the Worker serving updates (null: none).
// text: the notice shown once an update has been downloaded; updated: the notice on the
// first launch of a downloaded build. preHead: markup the loader
// keeps before <base>, for paths the runtime resolves itself ($WEBAPIS/…) and per-widget
// files at the widget root.
export async function writeWidget({ dir, html, exclude = [], stage, key, origin, text, updated, preHead = '' }) {
  const { id, page, files } = await describe(dir, html, exclude);
  await copyFiles(dir, files, path.join(stage, 'app'));
  const config = {
    key, id, manifest: origin ? origin.replace(/\/+$/, '') + '/tv-app/manifest.json' : null, text, updated,
    head: page.head, bodyAttrs: page.bodyAttrs, body: page.body,
  };
  await writeFile(path.join(stage, 'ota-config.js'), 'window.__OTA_CONFIG__ = ' + JSON.stringify(config) + ';\n');
  await cp(path.join(here, 'ota.js'), path.join(stage, 'ota.js'));
  const lang = page.lang ? ` lang="${page.lang}"` : '';
  await writeFile(path.join(stage, 'index.html'), `<!doctype html>
<html${lang}>
<head>
  <meta charset="utf-8">${preHead ? '\n  ' + preHead : ''}
  <script src="ota-config.js"></script>
  <script src="ota.js"></script>
</head>
<body></body>
</html>
`);
  return id;
}
