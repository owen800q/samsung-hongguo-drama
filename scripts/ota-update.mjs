// Publish the build for over-the-air updates: copies dist/ into the Worker's assets as
// worker-assets/tv-app/ (manifest.json and v/<build id>/). Installed apps check the
// manifest in the background and switch to a new build on their next launch.
// Run by the Worker build (wrangler.jsonc) after `vite build`.
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeUpdate } from '../ota/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'worker-assets');
rmSync(out, { recursive: true, force: true });
const id = await writeUpdate({ dir: dist, html: readFileSync(join(dist, 'index.html'), 'utf8'), out, headers: true });
console.log(`TV app build ${id} published to worker-assets/tv-app/.`);
