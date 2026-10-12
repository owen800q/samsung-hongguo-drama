// Assemble the Tizen widget from the Vite build and sign it when the Tizen CLI is
// available. Usage: npm run package [-- --profile <security-profile>]
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'build');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const profileArg = process.argv.indexOf('--profile');
const profile = profileArg > 0 ? process.argv[profileArg + 1] : process.env.TIZEN_PROFILE;

if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first');

// Keep config.xml's version in step with package.json.
const config = readFileSync(join(root, 'tizen/config.xml'), 'utf8').replace(/(<widget[^>]*\sversion=")[^"]*"/, `$1${pkg.version}"`);
writeFileSync(join(dist, 'config.xml'), config);
cpSync(join(root, 'tizen/icon.png'), join(dist, 'icon.png'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function hasTizen() {
  try { execFileSync('tizen', ['version'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

if (hasTizen()) {
  const args = ['package', '-t', 'wgt', '-o', out];
  if (profile) args.push('-s', profile);
  args.push('--', dist);
  execFileSync('tizen', args, { stdio: 'inherit' });
  console.log(`Signed widget written to ${out}/`);
} else {
  // Unsigned archive for inspection or for signing later (`tizen package -t wgt -s <profile> -- dist`).
  const target = join(out, `HongguoTV-${pkg.version}-unsigned.wgt`);
  execFileSync('zip', ['-qr', target, '.'], { cwd: dist });
  console.log(`Tizen CLI not found. Unsigned widget: ${target}`);
  console.log('A TV only installs signed widgets — see README「打包与安装」.');
}
