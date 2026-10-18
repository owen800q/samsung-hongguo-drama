// Drives the production build like the Tizen web simulator: Chromium at 1920x1080, a
// mocked `tizen` (input device + application, no filesystem), no CORS (the packaged app's
// access whitelist), and remote key codes, against the live sources.
// Usage: npm run build && npx vite preview --port 4173 & npm run e2e -- http://localhost:4173/
// Needs ffmpeg (for a VP9 stand-in clip) and Chromium (CHROMIUM_PATH, default Playwright's).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:4173/';
const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, userAgent: TV_UA });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(() => {
  const names = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
    'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info'];
  window.__registered = [];
  window.__exited = false;
  window.tizen = {
    tvinputdevice: {
      getSupportedKeys: () => names.map(name => ({ name, code: 0 })),
      registerKey: n => window.__registered.push(n),
      registerKeyBatch: list => list.forEach(n => window.__registered.push(n)),
    },
    application: { getCurrentApplication: () => ({ exit: () => { window.__exited = true; }, appInfo: { version: '1.0.0' } }) },
  };
});

// Remote keys: arrows/Enter as real key presses, the rest as keydown with the TV key code.
async function key(code) {
  const real = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter' }[code];
  if (real) await page.keyboard.press(real);
  else await page.evaluate(c => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => c });
    Object.defineProperty(e, 'which', { get: () => c });
    (document.activeElement || document.body).dispatchEvent(e);
  }, code);
  await page.waitForTimeout(350);
}
const focused = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.className + ' | ' + (a.textContent || '').trim().slice(0, 30)) : ''; });
const videoState = () => page.evaluate(() => { const v = document.querySelector('video.player-video'); return v ? { t: v.currentTime, paused: v.paused, src: v.currentSrc || v.src, rs: v.readyState } : null; });
async function waitPlaying(ms, from = 0.5) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await videoState();
    if (s && s.t > from && !s.paused) return s;
    if (await page.$('.player-error')) return { error: await page.textContent('.player-error') };
    await page.waitForTimeout(500);
  }
  return await videoState();
}

// This Chromium build has no H.264/HEVC decoder (Tizen has both): website episodes get a
// VP9 test clip in place of their MP4 so the player UI can be driven for real.
const clipPath = path.join(os.tmpdir(), 'hgtv-e2e-clip.webm');
if (!fs.existsSync(clipPath)) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=25', '-t', '60',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', clipPath]);
}
const clip = fs.readFileSync(clipPath);
const webMedia = [];
await page.route(/hongguoduanju\.com\/video\//, route => {
  webMedia.push(route.request().url());
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (!m) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: clip });
  const start = Number(m[1]); const end = m[2] ? Number(m[2]) : clip.length - 1;
  return route.fulfill({ status: 206, contentType: 'video/webm', body: clip.subarray(start, end + 1),
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${clip.length}` } });
});

try {
  await page.goto(URL_);
  await page.waitForSelector('.poster.focusable', { timeout: 30000 });
  await page.waitForTimeout(800);
  check('remote keys registered', (await page.evaluate(() => window.__registered.length)) >= 10);
  check('home starts with focus on a control', /focusable/.test(await focused()), await focused());

  // Browse → detail with the remote.
  for (let i = 0; i < 6 && !/poster/.test(await focused()); i++) await key(40);
  check('down moves focus onto the poster grid', /poster/.test(await focused()), await focused());
  await key(39); await key(37);
  await key(13);
  await page.waitForSelector('.detail .btn-primary:not([disabled])', { timeout: 30000 });
  await page.waitForTimeout(800);
  check('detail opens with play button focused', /btn-primary/.test(await focused()), await focused());

  // Episode 1 (website source, clear MP4).
  await key(13);
  await page.waitForSelector('video.player-video', { timeout: 15000 });
  let s = await waitPlaying(45000);
  check('episode 1 plays (website source)', s && !s.error && s.t > 0.5 && webMedia.length > 0, JSON.stringify(s));
  await page.waitForTimeout(6000);
  const osdHidden = await page.evaluate(() => !document.querySelector('.player.osd-visible'));
  check('OSD auto-hides while playing', osdHidden);
  const before = (await videoState()).t;
  await key(39); await page.waitForTimeout(1500);
  check('right key seeks forward', (await videoState()).t > before + 3, before + ' -> ' + (await videoState()).t);
  await key(19); await page.waitForTimeout(500);
  check('pause key pauses', (await videoState()).paused);
  await key(415); await page.waitForTimeout(800);
  check('play key resumes', !(await videoState()).paused);
  await key(404); await page.waitForTimeout(600);
  check('green key opens episode panel', !!(await page.$('.player-panel')));
  await key(10009); await page.waitForTimeout(600);
  check('back closes the panel', !(await page.$('.player-panel')));
  await key(427);
  await page.waitForFunction(() => /第 2 集/.test(document.querySelector('.player-sub').textContent), null, { timeout: 10000 }).catch(() => {});
  check('channel up switches to episode 2', /第 2 集/.test(await page.textContent('.player-sub')));

  // Back to detail, then pick an App-only (encrypted) episode on the grid.
  await key(10009); await page.waitForTimeout(300);
  if (await page.$('video.player-video')) await key(10009);
  await page.waitForSelector('.episode-grid .episode', { timeout: 10000 });
  await page.waitForTimeout(600);
  check('back from player restores focus to where playback started', /继续播放|立即播放/.test(await focused()), await focused());
  const webLimit = await page.evaluate(() => { const n = document.querySelector('.detail-note'); return n ? Number((n.textContent.match(/前 (\d+) 集/) || [])[1]) : 0; });
  const target = Math.max(webLimit + 1, 10);
  for (let i = 0; i < 10 && !/episode/.test(await focused()); i++) await key(40);
  const cur = Number((await focused()).split('|')[1].trim().match(/\d+/)[0]);
  for (let i = cur; i < target; i++) await key(39);
  check('focus on encrypted episode ' + target, (await focused()).includes(String(target)), await focused());

  // Fail the best App address: the player must fall back to the next one.
  const mediaHits = [];
  let failed = false;
  await page.route(/(qznovelvod|fqnovelvod|douyinvod)\.com/, async route => {
    mediaHits.push(route.request().url().split('?')[0]);
    if (!failed) { failed = true; return route.fulfill({ status: 404, body: '' }); }
    return route.continue();
  });
  await key(13);
  // The decrypted HEVC cannot be decoded here, so check the pipeline up to the <video>.
  const end = Date.now() + 120000;
  let src = '';
  while (Date.now() < end && !/^blob:/.test(src)) { await page.waitForTimeout(500); src = ((await videoState()) || {}).src || ''; }
  check('encrypted episode is downloaded, decrypted and handed to the player', /^blob:/.test(src), src);
  check('after the first App address fails the next one is used', mediaHits.length >= 2 && mediaHits[0] !== mediaHits[1], mediaHits.slice(0, 3).join(' , '));
  const sub = await page.textContent('.player-sub');
  check('player shows the episode', sub.includes('第 ' + target + ' 集'), sub);
  await page.unroute(/(qznovelvod|fqnovelvod|douyinvod)\.com/);

  // Leave: player → detail → home → exit dialog → exit.
  for (let i = 0; i < 6 && (await page.$('video.player-video, .detail')); i++) { await key(10009); await page.waitForTimeout(500); }
  check('back returns to home', !!(await page.$('.poster')), await focused());

  // Settings: the 红果 quality row cycles with the remote, is saved, and fits on screen.
  for (let i = 0; i < 8 && !/sidebar-item/.test(await focused()); i++) await key(37);
  for (let i = 0; i < 6 && !/设置/.test(await focused()); i++) await key(40);
  await key(13);
  await page.waitForSelector('.settings', { timeout: 10000 });
  for (let i = 0; i < 8 && !/红果清晰度/.test(await focused()); i++) await key(40);
  const qualityValue = () => page.evaluate(() => { const v = document.activeElement.querySelector('.setting-value'); return v ? v.textContent : ''; });
  const qualityBefore = await qualityValue();
  await key(13);
  const saved = await page.evaluate(() => { try { return Object.values(localStorage).join(' '); } catch (_) { return ''; } });
  check('quality setting cycles with the remote and is saved', qualityBefore === '自动' && (await qualityValue()) === '720P' && /"hongguoQuality":"720p"/.test(saved), qualityBefore + ' -> ' + (await qualityValue()));
  check('quality row fits the 1920 layout', await page.evaluate(() => {
    const r = document.activeElement.getBoundingClientRect();
    return r.right <= 1920 && r.bottom <= 1080 && document.activeElement.scrollWidth <= document.activeElement.clientWidth + 1;
  }));
  await key(13); await key(13);
  check('quality setting cycles back to auto', (await qualityValue()) === '自动', await qualityValue());
  await key(10009); await page.waitForTimeout(500);
  check('back from settings returns to home', !!(await page.$('.poster')), await focused());

  await key(10009); await page.waitForTimeout(500);
  const dialog = await page.evaluate(() => { const d = document.querySelector('[data-focus-scope]'); return d ? d.textContent : ''; });
  check('back on home asks to exit', /退出/.test(dialog), dialog.slice(0, 40));
  for (let i = 0; i < 4 && !/退出/.test(await focused()); i++) await key(i < 2 ? 37 : 39);
  await key(13);
  check('exit calls tizen application exit', await page.evaluate(() => window.__exited));
  check('no uncaught page errors', errors.length === 0, errors.join(' / '));
} catch (e) {
  check('e2e run completed', false, String(e && e.stack || e));
  await page.screenshot({ path: path.join(os.tmpdir(), 'hgtv-e2e-failure.png') }).catch(() => {});
} finally {
  await browser.close();
}
const failedCount = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
process.exit(failedCount ? 1 : 0);
