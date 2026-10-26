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
  // The packaged widget's OTA loader (ota/ota.js); the result of a check is set by the test.
  window.__otaResult = 'current';
  window.__ota = { running: '0123456789abcdef', bundled: '0123456789abcdef', remote: false,
    check: cb => setTimeout(() => cb(window.__otaResult), 300) };
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

// Protected 红果 pages only expose a preview, so the player skips them. The main run needs a
// website episode to drive, so its pages are unprotected; a separate page checks the fallback.
await page.route(/hongguoduanju\.com\/player\/[^?]*\/\d+/, async route => {
  try {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(/"protectedPlayback":true/g, '"protectedPlayback":false') });
  } catch (_) { /* request outlived the page */ }
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
  const corner = await page.evaluate(() => {
    const c = document.querySelector('.player.osd-visible .player-clock'), m = document.querySelector('.player-meta');
    const r = c ? c.getBoundingClientRect() : null, t = document.querySelector('.player-title').getBoundingClientRect();
    const v = document.querySelector('video.player-video');
    return { clock: c ? c.textContent : '', meta: m ? m.textContent : '', w: v.videoWidth, h: v.videoHeight, fits: !!r && r.right <= 1920 && r.top >= 0 && r.left >= t.right };
  });
  // The VP9 stand-in is 540x960; without a decodable picture the line stays hidden.
  const wantMeta = corner.w && corner.h ? '当前画面 ' + Math.min(corner.w, corner.h) + 'P（' + corner.w + ' × ' + corner.h + '）' : '';
  check('paused controls show the clock and the decoded picture size', /^\d\d:\d\d$/.test(corner.clock) && corner.fits && corner.meta === wantMeta && (!webMedia.length || corner.w === 540),
    JSON.stringify(corner));
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

  // Settings → 检查更新: up to date says so; a downloaded build offers a restart, focused, that Back dismisses.
  for (let i = 0; i < 8 && !/检查更新/.test(await focused()); i++) await key(40);
  check('check-for-updates row is reachable with the remote and on screen', /检查更新/.test(await focused()) && await page.evaluate(() => {
    const r = document.activeElement.getBoundingClientRect();
    return r.top >= 0 && r.right <= 1920 && r.bottom <= 1080;
  }), await focused());
  check('about shows the running build', /构建 0123456/.test(await page.textContent('.about')));
  await key(13); await page.waitForTimeout(500);
  const toastText = () => page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' / '));
  check('checking an up-to-date app says so', /已是最新版本/.test(await toastText()), await toastText());
  await page.evaluate(() => { window.__otaResult = 'downloaded'; });
  await key(13); await page.waitForTimeout(500);
  const restart = await page.evaluate(() => {
    const d = document.querySelector('.dialog');
    const a = document.activeElement;
    const r = a.getBoundingClientRect();
    return { text: d ? d.textContent : '', focused: (a.textContent || '').trim(), fits: r.right <= 1920 && r.bottom <= 1080 };
  });
  check('a downloaded update offers a restart with it focused', /新版本已下载/.test(restart.text) && restart.focused === '立即重启' && restart.fits, JSON.stringify(restart).slice(0, 120));
  await key(39);
  check('the restart dialog keeps focus inside it', /稍后/.test(await focused()), await focused());
  await key(10009); await page.waitForTimeout(400);
  check('back closes the restart dialog and returns to the row', !(await page.$('.dialog')) && /检查更新/.test(await focused()), await focused());

  await key(10009); await page.waitForTimeout(500);
  check('back from settings returns to home', !!(await page.$('.poster')), await focused());

  await key(10009); await page.waitForTimeout(500);
  const dialog = await page.evaluate(() => { const d = document.querySelector('[data-focus-scope]'); return d ? d.textContent : ''; });
  check('back on home asks to exit', /退出/.test(dialog), dialog.slice(0, 40));
  for (let i = 0; i < 4 && !/退出/.test(await focused()); i++) await key(i < 2 ? 37 : 39);
  await key(13);
  check('exit calls tizen application exit', await page.evaluate(() => window.__exited));
  check('no uncaught page errors', errors.length === 0, errors.join(' / '));

  // A rendering error shows a recovery prompt the remote can use, instead of a blank screen.
  const crash = await ctx.newPage();
  await crash.addInitScript(() => {
    // Inserting the detail screen throws once, like a bug in its render would.
    const wrap = name => {
      const original = Node.prototype[name];
      Node.prototype[name] = function (node) {
        if (window.__crashDetail && node && node.classList && node.classList.contains('screen-detail')) {
          window.__crashDetail = false;
          throw new Error('e2e crash');
        }
        return original.apply(this, arguments);
      };
    };
    wrap('insertBefore'); wrap('appendChild');
  });
  await crash.goto(URL_);
  await crash.waitForSelector('.poster.focusable', { timeout: 30000 });
  await crash.evaluate(() => { window.__crashDetail = true; document.querySelector('.poster.focusable').focus(); });
  await crash.keyboard.press('Enter');
  await crash.waitForSelector('.error-boundary', { timeout: 10000 }).catch(() => {});
  await crash.waitForTimeout(400);
  const prompt = await crash.evaluate(() => {
    const a = document.activeElement;
    const b = document.querySelector('.error-boundary .btn');
    const r = b && b.getBoundingClientRect();
    return { text: (document.querySelector('.error-boundary') || {}).textContent || '', focused: !!b && a === b, fits: !!r && r.right <= 1920 && r.bottom <= 1080 };
  });
  check('a render error shows a recovery prompt with reload focused', /界面出现异常/.test(prompt.text) && prompt.focused && prompt.fits, JSON.stringify(prompt).slice(0, 120));
  await Promise.all([crash.waitForEvent('load', { timeout: 15000 }), crash.keyboard.press('Enter')]).catch(() => {});
  await crash.waitForSelector('.poster.focusable', { timeout: 30000 }).catch(() => {});
  check('OK on the recovery prompt reloads the app', !!(await crash.$('.poster.focusable')) && !(await crash.$('.error-boundary')));
  await crash.close();

  // 红果 unreachable (its site resets connections): the catalog error offers the next source.
  const down = await ctx.newPage();
  await down.route(/hongguoduanju\.com/, route => route.abort('connectionreset'));
  await down.goto(URL_);
  await down.waitForSelector('.status-empty .btn', { timeout: 30000 }).catch(() => {});
  const downFocused = () => down.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? (a.textContent || '').trim() : ''; });
  for (let i = 0; i < 6 && !/重试/.test(await downFocused()); i++) { await down.keyboard.press('ArrowDown'); await down.waitForTimeout(300); }
  await down.keyboard.press('ArrowRight'); await down.waitForTimeout(300);
  check('a failed 红果 catalog offers switching source, reachable with the remote', /改看西饭/.test(await downFocused()), await downFocused());
  await down.keyboard.press('Enter');
  await down.waitForSelector('.poster.focusable', { timeout: 30000 }).catch(() => {});
  const switched = await down.evaluate(() => ({ posters: document.querySelectorAll('.poster.focusable').length,
    tab: ((document.querySelector('[data-focus-group="browse-source"] .is-selected') || {}).textContent || '').trim() }));
  check('switching from the error loads the 西饭 catalog', switched.posters > 0 && switched.tab === '西饭', JSON.stringify(switched));
  await down.close();

  // 观看记录: the 全部/未看完/已看完 filter works with the remote, and red deletes from the filtered grid.
  const hist = await ctx.newPage();
  await hist.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const now = Date.now();
    localStorage.setItem('hg.history', JSON.stringify([
      { series_id: '1', series_title: '没看完的剧', total: 5, vid: 'a', vid_index: 2, position: 30, duration: 60, updatedAt: now },
      { series_id: '2', series_title: '看完的剧', total: 3, vid: 'b', vid_index: 3, position: 60, duration: 60, updatedAt: now - 1000, completedEpisode: 3 },
      { series_id: '3', series_title: '更新了的剧', total: 3, vid: 'c', vid_index: 3, position: 60, duration: 60, updatedAt: now - 2000, completedEpisode: 3 },
    ]));
    localStorage.setItem('hg.favorites', JSON.stringify([
      { series_id: '3', series_title: '更新了的剧', total: 4, seenTotal: 3, addedAt: now, checkedAt: now },
    ]));
  });
  await hist.addInitScript(() => { window.tizen = { tvinputdevice: { registerKey() {} } }; });
  await hist.goto(URL_);
  await hist.waitForSelector('.sidebar-item', { timeout: 30000 });
  await hist.evaluate(() => document.querySelector('[data-sidebar-tab="history"]').focus());
  await hist.keyboard.press('Enter');
  await hist.waitForSelector('[data-focus-group="history-filter"]', { timeout: 10000 }).catch(() => {});
  await hist.waitForTimeout(500);
  const histState = () => hist.evaluate(() => ({
    chips: Array.from(document.querySelectorAll('[data-focus-group="history-filter"] .chip')).map(c => c.textContent.trim()),
    titles: Array.from(document.querySelectorAll('[data-focus-group="history-grid"] .poster-title')).map(t => t.textContent),
    badges: Array.from(document.querySelectorAll('[data-focus-group="history-grid"] .poster-badge')).map(t => t.textContent),
    focused: (document.activeElement.textContent || '').trim(),
  }));
  let hs = await histState();
  check('history shows 全部/未看完/已看完 counts; new episodes count as unfinished', hs.chips.join(',') === '全部 3,未看完 2,已看完 1', JSON.stringify(hs.chips));
  const histFocused = () => hist.evaluate(() => (document.activeElement.textContent || '').trim());
  for (let i = 0; i < 4 && !/^全部/.test(await histFocused()); i++) { await hist.keyboard.press('ArrowUp'); await hist.waitForTimeout(300); }
  for (let i = 0; i < 3 && !/^已看完/.test(await histFocused()); i++) { await hist.keyboard.press('ArrowRight'); await hist.waitForTimeout(300); }
  await hist.keyboard.press('Enter'); await hist.waitForTimeout(400);
  hs = await histState();
  check('the 已看完 filter is reachable with the remote and shows only finished series', hs.titles.join() === '看完的剧' && hs.badges.join() === '已看完', JSON.stringify(hs));
  await hist.keyboard.press('ArrowDown'); await hist.waitForTimeout(300);
  check('down from the filter moves onto the filtered grid', /看完的剧/.test(await histFocused()), await histFocused());
  await hist.evaluate(() => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 403 });
    document.activeElement.dispatchEvent(e);
  });
  await hist.waitForTimeout(400);
  hs = await histState();
  const left = await hist.evaluate(() => JSON.parse(localStorage.getItem('hg.history')).map(x => x.series_title).join());
  check('red key deletes the focused entry of the filtered grid', left === '没看完的剧,更新了的剧' && hs.chips.join(',') === '全部 2,未看完 2,已看完 0', left + ' ' + hs.chips.join(','));
  const emptyAll = await hist.evaluate(() => { const b = Array.from(document.querySelectorAll('.status-empty .btn')).find(x => /查看全部/.test(x.textContent)); return !!b; });
  check('an empty filter offers 查看全部', emptyAll);
  await hist.close();

  // Search ranks title matches first and fills in seasons; 查找下一季 on a season lists later
  // seasons of the same source as chips the remote can reach, and opens the picked one's detail.
  const seas = await ctx.newPage();
  await seas.addInitScript(() => { window.tizen = { tvinputdevice: { registerKey() {} } }; });
  seas.on('pageerror', e => errors.push('season page: ' + e));
  const seasFocused = () => seas.evaluate(() => (document.activeElement.textContent || '').trim());
  const press = async (k, n = 1) => { for (let i = 0; i < n; i++) { await seas.keyboard.press(k); await seas.waitForTimeout(300); } };
  await seas.goto(URL_);
  await seas.waitForSelector('.sidebar-item', { timeout: 30000 });
  await seas.evaluate(() => document.querySelector('[data-sidebar-tab="search"]').focus());
  await press('Enter');
  await seas.waitForSelector('.search-input', { timeout: 10000 });
  await seas.evaluate(() => document.querySelector('.search-input').focus());
  await press('Enter');
  await seas.keyboard.type('贞观憨婿');
  await press('Enter');
  await seas.waitForSelector('[data-focus-group="search-grid"] .poster', { timeout: 60000 }).catch(() => {});
  await seas.waitForFunction(() => document.querySelector('.result-head'), null, { timeout: 60000 }).catch(() => {});
  const grid = await seas.evaluate(() => ({
    titles: Array.from(document.querySelectorAll('[data-focus-group="search-grid"] .poster-title')).map(t => t.textContent),
    head: (document.querySelector('.result-head') || {}).textContent || '',
  }));
  const isMatch = t => t.replace(/\s/g, '').indexOf('贞观憨婿') >= 0;
  const firstOther = grid.titles.findIndex(t => !isMatch(t));
  check('search lists title matches before other results', grid.titles.length > 0 && isMatch(grid.titles[0]) && (firstOther < 0 || grid.titles.slice(firstOther).every(t => !isMatch(t))),
    grid.titles.slice(0, 8).join(','));
  check('the result head counts title matches', firstOther < 0 || /部标题匹配/.test(grid.head), grid.head);
  const seasonNo = t => { const m = /第([一二三四五六七八九十\d]+)季/.exec(t); return m ? '一二三四五六七八九'.indexOf(m[1]) + 1 || Number(m[1]) : 1; };
  const matches = grid.titles.filter(isMatch);
  const pick = grid.titles.indexOf(matches.slice().sort((a, b) => seasonNo(a) - seasonNo(b))[0]);
  const highest = Math.max.apply(null, matches.map(seasonNo));
  check('season results for a series name include several seasons', matches.length >= 2 && highest > seasonNo(grid.titles[pick]), matches.join(','));
  await seas.waitForTimeout(400);
  if (!/poster/.test(await seas.evaluate(() => document.activeElement.className))) await press('ArrowDown');
  await press('ArrowDown', Math.floor(pick / 6));
  await press('ArrowRight', pick % 6);
  const pickedTitle = grid.titles[pick];
  check('the remote reaches the earliest season poster', (await seasFocused()).indexOf(pickedTitle) >= 0, await seasFocused());
  await press('Enter');
  await seas.waitForSelector('.detail .btn-primary:not([disabled])', { timeout: 30000 });
  await seas.waitForTimeout(800);
  for (let i = 0; i < 4 && !/查找下一季/.test(await seasFocused()); i++) await press('ArrowRight');
  check('查找下一季 sits in the detail action row, on screen', /查找下一季/.test(await seasFocused()) && await seas.evaluate(() => {
    const r = document.activeElement.getBoundingClientRect();
    return r.right <= 1920 && r.bottom <= 1080;
  }), await seasFocused());
  await press('Enter');
  await seas.waitForFunction(() => document.querySelector('.detail-sequels'), null, { timeout: 60000 }).catch(() => {});
  const found = await seas.evaluate(() => ({
    chips: Array.from(document.querySelectorAll('[data-focus-group="detail-sequels"] .chip')).map(c => c.textContent),
    note: ((document.querySelector('.detail-sequels') || {}).textContent || '').trim(),
    focused: document.activeElement.tagName === 'BUTTON' ? (document.activeElement.textContent || '').trim() : document.activeElement.tagName,
    fits: Array.from(document.querySelectorAll('.detail-sequels .chip')).every(c => c.getBoundingClientRect().right <= 1920),
  }));
  check('查找下一季 lists only later seasons of the same series, with focus kept on the button',
    found.chips.length > 0 && found.chips.every(t => isMatch(t) && seasonNo(t) > seasonNo(pickedTitle)) && found.focused === '重新查找' && found.fits,
    JSON.stringify(found).slice(0, 200));
  await press('ArrowDown');
  const chip = await seasFocused();
  check('down from the actions moves onto a candidate', found.chips.indexOf(chip) >= 0, chip);
  await press('Enter');
  await seas.waitForFunction(t => Array.from(document.querySelectorAll('.detail-title')).some(h => h.textContent === t), chip, { timeout: 30000 }).catch(() => {});
  const opened = await seas.evaluate(() => Array.from(document.querySelectorAll('.screen.is-active .detail-title')).map(h => h.textContent).join());
  check('picking a candidate opens its detail, not playback', opened === chip && !(await seas.$('video.player-video')), opened);
  await seas.keyboard.press('Escape'); await seas.waitForTimeout(800);
  const back = await seas.evaluate(() => ({ title: Array.from(document.querySelectorAll('.screen.is-active .detail-title')).map(h => h.textContent).join(), focused: (document.activeElement.textContent || '').trim() }));
  check('back returns to the earlier season with focus on the candidate', (back.title === pickedTitle || back.title.replace(/\s/g, '') === pickedTitle.replace(/\s/g, '')) && back.focused === chip, JSON.stringify(back));
  await seas.close();

  // 红果 search goes through the website's search endpoint: a title written with different
  // punctuation still matches, and scrolling down loads its next page (10 results each).
  const hgs = await ctx.newPage();
  await hgs.addInitScript(() => { window.tizen = { tvinputdevice: { registerKey() {} } }; });
  hgs.on('pageerror', e => errors.push('hongguo search page: ' + e));
  const apiPages = [];
  hgs.on('request', r => { const m = /\/api\/search\/result\?.*page=(\d+)/.exec(r.url()); if (m) apiPages.push(Number(m[1])); });
  const hpress = async (k, n = 1) => { for (let i = 0; i < n; i++) { await hgs.keyboard.press(k); await hgs.waitForTimeout(300); } };
  await hgs.goto(URL_);
  await hgs.waitForSelector('.sidebar-item', { timeout: 30000 });
  await hgs.evaluate(() => document.querySelector('[data-sidebar-tab="search"]').focus());
  await hpress('Enter');
  await hgs.waitForSelector('.search-input', { timeout: 10000 });
  await hgs.evaluate(() => document.querySelector('.search-input').focus());
  await hpress('ArrowDown');
  for (let i = 0; i < 4 && (await hgs.evaluate(() => document.activeElement.textContent.trim())) !== '红果'; i++) await hpress('ArrowRight');
  await hpress('Enter');
  await hgs.evaluate(() => document.querySelector('.search-input').focus());
  await hpress('Enter');
  await hgs.keyboard.type('谁说纨绔，不能当状元');
  await hpress('Enter');
  await hgs.waitForFunction(() => document.querySelector('.result-head') || document.querySelector('.status-empty'), null, { timeout: 60000 }).catch(() => {});
  await hgs.waitForTimeout(600);
  const hg = await hgs.evaluate(() => ({
    titles: Array.from(document.querySelectorAll('[data-focus-group="search-grid"] .poster-title')).map(t => t.textContent),
    head: ((document.querySelector('.result-head') || document.querySelector('.status-empty') || {}).textContent || '').trim(),
    focused: document.activeElement.className,
  }));
  check('红果 search finds the series although the keyword has extra punctuation',
    hg.titles[0] === '谁说纨绔不能当状元' && /poster/.test(hg.focused), hg.titles.slice(0, 4).join(',') + ' | ' + hg.head.slice(0, 80));
  const firstPage = hg.titles.length;
  for (let i = 0; i < 4; i++) await hpress('ArrowDown');
  await hgs.waitForFunction(n => document.querySelectorAll('[data-focus-group="search-grid"] .poster').length > n, firstPage, { timeout: 30000 }).catch(() => {});
  const grown = await hgs.evaluate(() => document.querySelectorAll('[data-focus-group="search-grid"] .poster').length);
  check('scrolling down loads the next 红果 search page', grown > firstPage && apiPages.indexOf(2) >= 0, firstPage + ' -> ' + grown + ' pages ' + apiPages.join(','));
  await hgs.close();

  // A protected 红果 page only exposes a ~10 s preview: playback must use the App source instead.
  const prot = await ctx.newPage();
  await prot.addInitScript(() => { window.tizen = { tvinputdevice: { registerKey() {} }, application: { getCurrentApplication: () => ({ exit() {} }) } }; });
  const protMedia = [];
  let protPages = 0;
  await prot.route(/hongguoduanju\.com\/video\//, route => { protMedia.push(route.request().url()); return route.abort(); });
  await prot.route(/hongguoduanju\.com\/player\/[^?]*\/\d+/, async route => {
    try {
      const res = await route.fetch();
      const body = (await res.text()).replace(/"protectedPlayback":(true|false),?/g, '').replace(/"publicVideoSeo":/g, '"protectedPlayback":true,"publicVideoSeo":');
      if (body.indexOf('"protectedPlayback":true') >= 0) protPages++;
      await route.fulfill({ response: res, body });
    } catch (_) { /* a next-episode prefetch still in flight when the page closes */ }
  });
  await prot.goto(URL_);
  await prot.waitForSelector('.poster.focusable', { timeout: 30000 });
  await prot.evaluate(() => document.querySelector('.poster.focusable').focus());
  await prot.keyboard.press('Enter');
  await prot.waitForSelector('.detail .btn-primary:not([disabled])', { timeout: 30000 });
  await prot.waitForTimeout(600);
  await prot.keyboard.press('Enter');
  const protEnd = Date.now() + 120000;
  let protSrc = '';
  while (Date.now() < protEnd && !/^blob:/.test(protSrc)) {
    await prot.waitForTimeout(500);
    protSrc = await prot.evaluate(() => { const v = document.querySelector('video.player-video'); return v ? v.currentSrc || v.src : ''; });
    if (await prot.$('.player-error')) break;
  }
  check('a protected preview page falls back to the App source', protPages > 0 && /^blob:/.test(protSrc) && protMedia.length === 0, protSrc + ' protected pages: ' + protPages + ', web hits: ' + protMedia.length);
  await prot.close();
} catch (e) {
  check('e2e run completed', false, String(e && e.stack || e));
  await page.screenshot({ path: path.join(os.tmpdir(), 'hgtv-e2e-failure.png') }).catch(() => {});
} finally {
  await browser.close();
}
const failedCount = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
process.exit(failedCount ? 1 : 0);
