// 红果 via the official website (hongguoduanju.com) and the App. Until November 2026 the
// server-rendered player pages embedded the full episode vid list; they now list only the
// few public episodes, under opaque `v1_...` ids, so the list comes from the App's detail
// endpoint and the page adds tags and the public range (upstream 8.5).
import { CancelToken, getJson, getText, request, memo, withQuery } from '../lib/http.js';
import { decodeHtml, httpsUrl, isPublicMediaUrl, readRouterData, uniqueBy } from './util.js';
import { fetchAppPlayUrl, fetchAppEpisodeList } from './app-source.js';

const SITE = 'https://hongguoduanju.com';
const episodesCache = memo(60000, 32);
const playCache = memo(30000, 64);

function normalizeVideoUrl(raw) {
  return String(raw || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/([?&])Range=[^&]*/gi, '$1')
    .replace(/[?&]$/, '');
}

function fetchSiteHtml(url, options = {}) {
  return getText(url, Object.assign({ timeout: 20000 }, options, { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }));
}

const PUBLIC_TOKEN = /^v\d+_[A-Za-z0-9_-]{8,128}$/;

/**
 * The series in a player or detail page → episode list; throws when the page is not this
 * series. A page that lists only its public episodes (fewer than the series has, or under
 * opaque `v1_...` ids) gives `complete: false`, no `episodes`, and those ids as `public_tokens`.
 */
export function parseEpisodeListHtml(html, seriesId) {
  const loader = readRouterData(html).loaderData || {};
  const data = loader['player_(series_id)/page'] || loader['player_(series_id)/(vid)/page'] || loader.detail_page;
  const detail = data && data.seriesDetail;
  // Identity and episodes come from the current player's own object, never from recommendations.
  if (!data || data.isSuccess === false || !detail || String(detail.series_id) !== String(seriesId) ||
      (data.series_id != null && String(data.series_id) !== String(seriesId))) {
    throw new Error('红果官网返回的剧集与请求不一致，请稍后重试');
  }
  if (!Array.isArray(detail.vid_list)) throw new Error('红果官网未返回分集数据，请稍后重试');
  const vids = detail.vid_list.map(String);
  const opaque = vids.length > 0 && vids.every(v => PUBLIC_TOKEN.test(v));
  if ((!opaque && vids.some(v => !/^\d{1,30}$/.test(v))) || new Set(vids).size !== vids.length) throw new Error('红果分集数据异常，请稍后重试');
  if (!vids.length) throw new Error('红果分集列表为空');
  const count = Number(detail.episode_cnt) || Number(detail.series_episode_info && detail.series_episode_info.episode_cnt) || null;
  const complete = !opaque && (count == null || vids.length >= count);
  const text = value => typeof value === 'string' ? value : '';
  const accessible = /^\d+$/.test(String(detail.accessible_episode_cnt)) ? Math.min(Number(detail.accessible_episode_cnt), vids.length) : null;
  return {
    series_id: String(seriesId),
    series_title: text(detail.series_name) || text(detail.series_title) || '未命名短剧',
    cover: text(detail.series_cover),
    intro: text(detail.series_intro),
    tags: Array.isArray(detail.tags) ? detail.tags.filter(t => typeof t === 'string').slice(0, 6) : [],
    total: complete ? vids.length : count || vids.length,
    web_accessible_episodes: accessible,
    complete,
    public_tokens: opaque ? vids : [],
    // Episodes past the web range are still attempted through the App source.
    episodes: complete ? vids.map((vid, i) => ({ vid, vid_index: i + 1, title: '', locked: false })) : [],
    source: 'hongguo',
  };
}

// Some player pages come from a CDN edge that hangs or resets the connection while the
// detail page of the same series is fine (upstream 3.6). Each round asks both pages and
// keeps the first valid list; a round that has not answered after EPISODE_HEDGE_MS, or
// that fails, starts another on fresh connections. TV networks are slower than upstream's
// desktop, so the rounds keep the old 20 s limit instead of 1.5 s / 3.5 s cut-offs.
export const EPISODE_HEDGE_MS = 3000;
const EPISODE_ROUNDS = 3;
const EPISODE_BUDGET = 20000;

// Upstream 3.6 no longer shows raw "aborted"; a TV shows a sentence instead of "请求超时".
function episodeLoadError(errors) {
  const say = error => {
    const message = (error && error.message) || '';
    if (/^HTTP \d+$/.test(message)) return '红果官网暂不可用（' + message + '）';
    return /红果/.test(message) ? message : '红果分集加载超时或连接中断';
  };
  const first = say(errors[0]);
  const last = say(errors[errors.length - 1]);
  return new Error(first === last ? first + '，请重试' : first + '；重试失败：' + last);
}

function fetchEpisodeRound(seriesId, timeout, cancel) {
  const id = encodeURIComponent(seriesId);
  return new Promise((resolve, reject) => {
    let failed = 0;
    let firstError = null;
    [SITE + '/player/' + id, SITE + '/detail?series_id=' + id].forEach(url => {
      fetchSiteHtml(url, { timeout, cancel }).then(html => parseEpisodeListHtml(html, seriesId)).then(resolve, error => {
        firstError = firstError || error;
        if (++failed === 2) reject(firstError);
      });
    });
  });
}

function fetchEpisodeListFromWeb(seriesId, { hedgeMs = EPISODE_HEDGE_MS, budget = EPISODE_BUDGET } = {}) {
  const deadline = Date.now() + budget;
  return new Promise((resolve, reject) => {
    const tokens = [];
    const errors = [];
    let running = 0;
    let done = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tokens.forEach(token => token.cancel());
      fn(value);
    };
    const launch = () => {
      clearTimeout(timer);
      const left = deadline - Date.now();
      if (done || tokens.length >= EPISODE_ROUNDS || left < 1000) {
        if (!running) finish(reject, episodeLoadError(errors));
        return;
      }
      const token = new CancelToken();
      tokens.push(token);
      running++;
      fetchEpisodeRound(seriesId, left, token).then(value => finish(resolve, value), error => {
        running--;
        errors.push(error);
        if (!done) launch();
      });
      timer = setTimeout(launch, hedgeMs);
    };
    launch();
  });
}

// How long a finished App list waits for the website's page (tags, public range).
export const WEB_DETAILS_GRACE_MS = 2500;

function describeAppListError(error) {
  if (error && error.network) return error.timedOut ? '请求超时' : '网络连接失败';
  if (error && (error.registration || error.registrationFailure)) return '匿名设备登记失败';
  if (error && error.empty) return '接口返回空响应';
  if (error && (error.rejected || error.businessCode)) return '接口暂时拒绝请求';
  return (error && /^App /.test(error.message || '') && error.message) || '暂不可用';
}

/**
 * Upstream 8.5: the App's detail endpoint gives the whole list; the website's page, asked at
 * the same time, adds tags and how many episodes are public. When the App fails, a page that
 * still lists every episode is used; one that lists only its public episodes is not a list.
 */
async function fetchEpisodeListFresh(seriesId, options) {
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  const webPending = settled(fetchEpisodeListFromWeb(seriesId, options));
  const app = await settled(fetchAppEpisodeList(seriesId, { timeout: options.appTimeout }));
  if (app.error) {
    const web = await webPending;
    if (web.error) throw web.error;
    if (web.value.complete) return web.value;
    throw new Error('红果官网只列出公开的前几集，完整分集来自 App 接口（' + describeAppListError(app.error) + '），请稍后重试');
  }
  const grace = options.webGrace == null ? WEB_DETAILS_GRACE_MS : options.webGrace;
  const web = (await Promise.race([webPending, new Promise(resolve => setTimeout(resolve, grace, {}))])).value;
  const list = app.value;
  // The App repeats the series introduction as every episode's title.
  list.episodes.forEach(episode => { if (episode.title === list.intro) episode.title = ''; });
  return {
    series_id: list.series_id,
    series_title: (web && web.series_title !== '未命名短剧' && web.series_title) || list.series_title,
    cover: (web && web.cover) || list.cover,
    intro: list.intro || (web && web.intro) || '',
    tags: web ? web.tags : [],
    total: list.total,
    web_accessible_episodes: web && web.web_accessible_episodes != null ? Math.min(web.web_accessible_episodes, list.total) : null,
    complete: true,
    public_tokens: web ? web.public_tokens : [],
    episodes: list.episodes,
    source: 'hongguo',
  };
}

export function fetchEpisodeList(seriesId, options = {}) {
  return episodesCache('episodes:' + seriesId, () => fetchEpisodeListFresh(String(seriesId), options), options.force);
}

// Upstream 8.5: the public stream endpoint only knows the page's opaque ids, which are
// listed in episode order.
const tokensCache = memo(300000, 32);
function fetchPublicTokens(sid) {
  return tokensCache('tokens:' + sid, async () => {
    const page = parseEpisodeListHtml(await fetchSiteHtml(SITE + '/player/' + encodeURIComponent(sid), { timeout: 4000 }), sid);
    return page.public_tokens;
  });
}

/**
 * The clear MP4 of exactly this episode from a player page, or ''. The page also lists
 * recommended videos, so the address must come from the VideoObject bound to this
 * player, and the page model must confirm the episode is publicly playable and not protected.
 */
export function pickWebMedia(html, vid, sid) {
  let data;
  try { data = (readRouterData(html).loaderData || {})['player_(series_id)/(vid)/page']; } catch (_) { return ''; }
  const actualSid = String((data && data.series_id) || '');
  const seo = data && data.publicVideoSeo;
  if (!data || data.isSuccess === false || String(data.vid) !== String(vid) || !/^\d+$/.test(actualSid) ||
      (sid && actualSid !== String(sid)) || String(data.seriesDetail && data.seriesDetail.series_id) !== actualSid ||
      !seo || seo.available !== true || String(seo.itemId) !== String(vid) || String(seo.seriesId) !== actualSid ||
      // A protected page's public file is a ~10 s preview, even when its metadata claims the full length.
      data.protectedPlayback === true) return '';
  const matchesPlayer = (value, media) => {
    try {
      const target = new URL(value);
      return target.origin === SITE && !target.username && !target.password &&
        (target.pathname === '/player/' + actualSid + '/' + String(vid) ||
          // The canonical series URL omits vid, so the site's own media path must name this episode.
          (target.pathname === '/player/' + actualSid && media.origin === SITE &&
            media.pathname.indexOf('/video/public/' + String(vid) + '/') === 0));
    } catch (_) { return false; }
  };
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = scripts.exec(html))) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(m[1])) continue;
    let video;
    try { video = JSON.parse(m[2]); } catch (_) { continue; }
    if (!video || video['@type'] !== 'VideoObject') continue;
    const url = mediaUrl(normalizeVideoUrl(video.contentUrl));
    if (!url) continue;
    const media = new URL(url);
    if (matchesPlayer(video.url, media) && (!video['@id'] || matchesPlayer(video['@id'], media))) return url;
  }
  return '';
}

function mediaUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && isPublicMediaUrl(url.href) ? url.href : '';
  } catch (_) { return ''; }
}

/** `pageId` is what the site calls the episode: `vid`, or since upstream 8.5 its opaque id. */
async function fetchPlayUrlFromWeb(vid, sid, pageId = vid) {
  const candidates = [];
  if (sid) candidates.push(SITE + '/player/' + encodeURIComponent(sid) + '/' + encodeURIComponent(pageId));
  // An opaque id belongs to its series; only a numeric one has a page of its own.
  if (pageId === vid) candidates.push(SITE + '/player/_/' + encodeURIComponent(vid));
  for (const url of candidates) {
    try {
      const videoUrl = pickWebMedia(await fetchSiteHtml(url), pageId, sid);
      if (videoUrl) return { url: videoUrl, contentKey: null, codec: '', quality: '', source: 'web', vid: String(vid) };
    } catch (_) { /* try the next form, then the App source */ }
  }
  return null;
}

// Upstream 8.0: the endpoint the website's own player asks when a page is protected. For
// the episodes the site shows publicly it answers with the full episode as a clear
// 360 x 640 H.264 MP4 (not the ~10 s preview of the page's metadata), and it kept
// answering in November 2026 while every App endpoint returned empty bodies.
const PUBLIC_FALLBACK_API = SITE + '/api/video/protected/fallback-play-info';

/**
 * The website's public stream for `vid`, or null when the answer is unusable. Rejects with
 * `publicLimited` when the site does not offer the episode publicly (HTTP 403 or 400).
 * Upstream 8.5: `token` is the page's opaque id of this episode, asked for in place of `vid`.
 */
export async function fetchPublicFallbackPlayUrl(vid, token) {
  if (!/^\d{1,30}$/.test(String(vid))) return null;
  if (token != null && !PUBLIC_TOKEN.test(String(token))) return null;
  let payload;
  try {
    payload = await getJson(PUBLIC_FALLBACK_API, {
      method: 'POST', timeout: 6000, headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: String(token == null ? vid : token) }),
    });
  } catch (error) {
    // 403: not public. 400 (since November 2026): the site no longer accepts this id.
    if (error && (error.status === 403 || error.status === 400)) throw Object.assign(new Error('官网公开片源不提供本集'), { publicLimited: true });
    throw error;
  }
  if (!payload || typeof payload !== 'object') return null;
  const status = payload.base_resp && payload.base_resp.StatusCode != null ? payload.base_resp.StatusCode : payload.code;
  if (Number(status || 0) !== 0) return null;
  let media;
  try { media = new URL(normalizeVideoUrl(payload.main_url)); } catch (_) { return null; }
  if (media.protocol !== 'https:' || media.username || media.password || !isPublicMediaUrl(media.href) ||
      !/(^|\.)(?:qznovelvod|fqnovelvod|douyinvod)\.com$/i.test(media.hostname)) return null;
  const expires = Number(payload.url_expire);
  if (isFinite(expires) && expires > 0 && expires * 1000 <= Date.now() + 5000) return null;
  return { url: media.href, contentKey: null, codec: 'h264', quality: '360p', source: 'web', vid: String(vid) };
}

// Episodes whose website CDN address just failed to load, until when (ms).
const failedWebMedia = new Map();

/**
 * The website's media address for `vid` failed to play. For a few minutes, lookups prefer
 * the App source, keeping the website only as a last resort.
 */
export function markWebMediaFailure(vid) {
  failedWebMedia.delete(String(vid));
  failedWebMedia.set(String(vid), Date.now() + 5 * 60 * 1000);
  if (failedWebMedia.size > 128) failedWebMedia.delete(failedWebMedia.keys().next().value);
}

async function fetchPlayInfoFresh(vid, sid, skipWeb) {
  // Only trust the web page for episodes inside the web-accessible range; past it the
  // page may embed a preview of another episode.
  let series = null;
  if (sid) { try { series = await fetchEpisodeList(sid); } catch (_) {} }
  const index = series ? series.episodes.findIndex(e => e.vid === String(vid)) : -1;
  const accessible = series ? series.web_accessible_episodes : null;
  const inWebRange = !(typeof accessible === 'number' && index >= accessible);
  // Upstream 8.5: where the site lists opaque ids, its pages and its public stream go by
  // them, in episode order; an episode past the listed ones has no page.
  let tokens = (series && series.public_tokens) || [];
  const pageId = () => tokens.length ? tokens[index] : vid;
  if (inWebRange && !skipWeb && pageId()) {
    const web = await fetchPlayUrlFromWeb(vid, sid, pageId());
    if (web) return web;
  }
  let appError = null;
  try {
    return await fetchAppPlayUrl(String(vid));
  } catch (error) { appError = error; /* fall through to an explanatory error */ }
  // A CDN hiccup changes the order of the sources, not whether the website has the episode.
  if (inWebRange && skipWeb && pageId()) {
    const web = await fetchPlayUrlFromWeb(vid, sid, pageId());
    if (web) return web;
  }
  // Upstream 8.0/8.1: when the App gave nothing, the website's public 360P stream of the
  // whole episode is the last resort. It comes after the App so that it never replaces a
  // better App stream. An episode that only exists as ByteVC2 may still play this way.
  let publicLimited = false;
  try {
    // The list may have come without the page's ids (website slow or down at the time).
    if (!tokens.length && sid && index >= 0 && index < 10) { try { tokens = await fetchPublicTokens(sid); } catch (_) {} }
    const fallback = await fetchPublicFallbackPlayUrl(vid, (index >= 0 && tokens[index]) || null);
    if (fallback) return fallback;
  } catch (error) { publicLimited = !!(error && error.publicLimited); }
  if (appError && appError.network) throw new Error('网络连接失败，未能获取播放地址，请检查电视网络后重试');
  // Upstream 5.6: an episode that only exists as ByteVC2 will not play however often it is retried.
  if (appError && appError.code === 'UNSUPPORTED_CODEC') throw Object.assign(new Error(appError.message), { appRejected: true });
  // Upstream 5.7: when the App refused the request, automatic retries (prefetch) stop.
  const rejected = { appRejected: !!(appError && appError.rejected) };
  if (!inWebRange) {
    const range = accessible > 0 ? '仅提供前 ' + accessible + ' 集' : '暂未提供可播放分集';
    throw Object.assign(new Error('红果官网当前' + range + '，第 ' + (index + 1) + ' 集暂时无法获取播放地址，请稍后重试。'), rejected);
  }
  // Upstream 8.1: the site said outright that this episode is not public.
  if (publicLimited) throw Object.assign(new Error('官网公开片源不提供本集，备用接口也未返回播放地址。请稍后重试；若该集只对官方 App 开放，请在官方 App 观看。'), rejected);
  throw Object.assign(new Error('红果官网与备用接口均未提供播放地址，请稍后重试'), rejected);
}

// A chosen quality needs the App source: the website gives one stream of unknown size.
async function fetchPlayInfoAtQuality(vid, quality) {
  try {
    return await fetchAppPlayUrl(vid, { quality });
  } catch (error) {
    if (error && error.network) throw new Error('网络连接失败，未能获取播放地址，请检查电视网络后重试');
    if (error && error.code === 'UNSUPPORTED_CODEC') throw Object.assign(new Error(error.message), { appRejected: true });
    const reason = error && error.quality ? error.message : '备用接口未提供 ' + quality.toUpperCase() + ' 片源，未自动降级';
    throw new Error(reason + '。可在「设置」里把红果清晰度改为「自动」后重试。');
  }
}

/**
 * `options.force` looks the address up again instead of reusing a recent one.
 * `options.quality`: 'auto', '720p' or '1080p' (see fetchAppPlayUrl).
 */
export function fetchPlayInfo(vid, sid, options = {}) {
  const quality = options.quality === '720p' || options.quality === '1080p' ? options.quality : 'auto';
  if (quality !== 'auto') {
    return playCache('play:' + vid + ':' + quality, () => fetchPlayInfoAtQuality(String(vid), quality), options.force);
  }
  const skipWeb = (failedWebMedia.get(String(vid)) || 0) > Date.now();
  return playCache('play:' + (sid || '') + ':' + vid + (skipWeb ? ':fallback' : ''),
    () => fetchPlayInfoFresh(String(vid), sid ? String(sid) : '', skipWeb), options.force);
}

/** Numeric series id, a hongguoduanju.com URL, or share text containing a link → series id. */
export async function resolveSeriesId(input) {
  const trimmed = String(input || '').trim();
  if (/^\d{1,30}$/.test(trimmed)) return trimmed;
  const linkMatch = trimmed.match(/https?:\/\/[^\s<>"'，。！？；、【】（）]+/i);
  if (!linkMatch) throw new Error('请输入剧集 ID 或分享链接');
  const res = await request(linkMatch[0].replace(/[),.;!]+$/, ''), { responseType: 'text', timeout: 20000 });
  const url = new URL(res.url);
  const direct = url.searchParams.get('video_series_id') || url.searchParams.get('series_id');
  if (/^\d{1,30}$/.test(direct || '')) return direct;
  const player = url.pathname.match(/^\/player\/(\d{1,30})(?:\/|$)/);
  if (player) return player[1];
  const body = typeof res.data === 'string' ? res.data : '';
  const m = body.match(/video_series_id=(\d{1,30})(?!\d)/) || body.match(/"(?:video_id|series_id)"\s*:\s*"(\d{1,30})"/);
  if (m) return m[1];
  throw new Error('无法从链接解析剧集 ID');
}

// The search page is an empty shell; its script fetches this endpoint, which needs no
// signature, cookie or Referer. It pages 10 results at a time and sometimes hangs or
// answers 502, so each page gets one retry and successful pages are kept for a minute.
const SEARCH_API = SITE + '/api/search/result';
const searchCache = memo(60000, 30);
export const SEARCH_MAX_PAGE = 50;

function searchError(message, retry) {
  const error = new Error(message);
  error.retry = retry;
  return error;
}

function searchCount(video) {
  const n = Number(video && video.episode_cnt);
  if (Number.isInteger(n) && n > 0) return n;
  const m = String((video && video.episode_right_text) || '').match(/(\d+)\s*集/);
  return m ? Number(m[1]) : 0;
}

/** The endpoint's JSON → { results, total, totalPages, page, hasMore }; throws on an unusable answer. */
export function parseSearchResponse(payload) {
  if (payload == null || payload === '' || typeof payload === 'string') throw searchError('红果搜索服务暂不可用，请稍后重试', true);
  if (typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.searchList)) {
    if (payload && typeof payload.code === 'string') throw searchError('红果搜索服务暂不可用（' + (payload.message || payload.code) + '）', true);
    throw searchError('红果搜索返回异常数据，接口可能已变化', false);
  }
  const results = uniqueBy(payload.searchList.map(item => {
    const data = item && item.video_data;
    const v = data && typeof data === 'object' && Object.keys(data).length ? data : (item || {});
    // Some entries leave video_data empty and carry the series id in `keyword`.
    const id = String(v.series_id || (item && item.series_id) || (item && item.keyword) || '').trim();
    const title = decodeHtml(String(v.series_title || v.series_name || (item && item.name) || '')).trim();
    const tags = Array.isArray(v.category_list) ? v.category_list : Array.isArray(v.tags) ? v.tags : [];
    return {
      series_id: id,
      series_title: title,
      cover: httpsUrl(normalizeVideoUrl(v.series_cover || v.cover || '')),
      episode_count: searchCount(v),
      tags: tags.map(t => typeof t === 'string' ? t : t && t.name).filter(t => typeof t === 'string' && t).slice(0, 4),
      intro: typeof v.series_intro === 'string' ? decodeHtml(v.series_intro) : '',
      heat: v.hot_score_data && typeof v.hot_score_data.text === 'string' ? v.hot_score_data.text : '',
      source: 'hongguo',
    };
  }).filter(r => /^\d{6,30}$/.test(r.series_id) && r.series_title), r => r.series_id);
  // Entries were returned but none could be read: the format changed, which is not "no results".
  if (!results.length && payload.searchList.length) throw searchError('红果搜索结果无法识别，接口可能已变化', false);
  const num = (value, min) => { const n = Number(value); return Number.isFinite(n) && n >= min ? n : null; };
  return {
    results,
    total: num(payload.totalCount, 0) == null ? results.length : num(payload.totalCount, 0),
    totalPages: num(payload.totalPages, 0) || 0,
    page: num(payload.pageNum, 1) || 1,
    hasMore: payload.hasMore === true,
  };
}

async function fetchSearchPage(kw, page, deadline) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline ? deadline - Date.now() : Infinity;
    if (left < 1000) { lastError = lastError || searchError('红果搜索超时，请稍后重试', false); break; }
    try {
      const data = await getJson(withQuery(SEARCH_API, { aid: 8662, query: kw, page }),
        { timeout: Math.min(10000, left), headers: { Accept: 'application/json, text/plain, */*' } });
      return parseSearchResponse(data);
    } catch (error) {
      const status = error && error.status;
      lastError = error && error.retry !== undefined ? error
        : error && error.message === '请求超时' ? searchError('红果搜索超时，请稍后重试', true)
        : status === 429 ? searchError('红果搜索请求过于频繁，请稍后重试', true)
        : status >= 500 ? searchError('红果搜索服务暂不可用（HTTP ' + status + '）', true)
        : status >= 400 ? searchError('红果搜索接口已变化（HTTP ' + status + '）', false)
        : searchError('红果搜索失败，请检查网络后重试', true);
      if (!lastError.retry) break;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

/** `options.deadline` (ms timestamp) bounds the whole search, retries included. */
export async function search(keyword, page = 1, options = {}) {
  try {
    const kw = String(keyword || '').normalize('NFKC').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    if (kw.length > 200) throw new Error('搜索关键词最多 200 字');
    const pg = parseInt(page, 10) || 1;
    if (pg < 1 || pg > SEARCH_MAX_PAGE) throw new Error('红果搜索最多翻到第 ' + SEARCH_MAX_PAGE + ' 页');
    const res = await searchCache('search:' + pg + ':' + kw, () => fetchSearchPage(kw, pg, options.deadline || 0));
    const hasMore = res.hasMore && res.results.length > 0 && pg < SEARCH_MAX_PAGE;
    return { success: true, results: res.results, page: pg, total: res.total, totalPages: res.totalPages, hasMore, nextPage: hasMore ? pg + 1 : null };
  } catch (error) {
    return { success: false, error: /红果|关键词/.test(error.message) ? error.message : '红果搜索失败，请检查网络后重试' };
  }
}
