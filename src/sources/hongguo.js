// 红果 via the official website (hongguoduanju.com). Player pages are server-rendered
// and embed the full episode vid list plus clear MP4 links for the web-accessible range.
import { getJson, getText, request, memo, withQuery } from '../lib/http.js';
import { decodeHtml, httpsUrl, readRouterData, uniqueBy } from './util.js';
import { fetchAppPlayUrl } from './app-source.js';

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

function fetchSiteHtml(url) {
  return getText(url, { timeout: 20000, headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
}

async function fetchEpisodeListFromWeb(seriesId) {
  const html = await fetchSiteHtml(SITE + '/player/' + encodeURIComponent(seriesId));
  const loader = readRouterData(html).loaderData || {};
  const data = loader['player_(series_id)/page'] || loader['player_(series_id)/(vid)/page'];
  const detail = data && data.seriesDetail;
  // Identity and episodes come from the current player's own object, never from recommendations.
  if (!data || data.isSuccess === false || !detail || String(detail.series_id) !== String(seriesId) ||
      (data.series_id != null && String(data.series_id) !== String(seriesId))) {
    throw new Error('红果官网返回的剧集与请求不一致，请稍后重试');
  }
  if (!Array.isArray(detail.vid_list)) throw new Error('红果官网未返回分集数据，请稍后重试');
  const vids = detail.vid_list.map(String);
  if (vids.some(v => !/^\d{1,30}$/.test(v)) || new Set(vids).size !== vids.length) throw new Error('红果分集数据异常，请稍后重试');
  if (!vids.length) throw new Error('红果分集列表为空');
  const text = value => typeof value === 'string' ? value : '';
  const accessible = /^\d+$/.test(String(detail.accessible_episode_cnt)) ? Math.min(Number(detail.accessible_episode_cnt), vids.length) : null;
  return {
    series_id: String(seriesId),
    series_title: text(detail.series_name) || text(detail.series_title) || '未命名短剧',
    cover: text(detail.series_cover),
    intro: text(detail.series_intro),
    tags: Array.isArray(detail.tags) ? detail.tags.filter(t => typeof t === 'string').slice(0, 6) : [],
    total: vids.length,
    web_accessible_episodes: accessible,
    // Episodes past the web range are still attempted through the App source.
    episodes: vids.map((vid, i) => ({ vid, vid_index: i + 1, title: '', locked: false })),
    source: 'hongguo',
  };
}

export function fetchEpisodeList(seriesId, options = {}) {
  return episodesCache('episodes:' + seriesId, () => fetchEpisodeListFromWeb(String(seriesId)), options.force);
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
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

async function fetchPlayUrlFromWeb(vid, sid) {
  const candidates = [];
  if (sid) candidates.push(SITE + '/player/' + encodeURIComponent(sid) + '/' + encodeURIComponent(vid));
  candidates.push(SITE + '/player/_/' + encodeURIComponent(vid));
  for (const url of candidates) {
    try {
      const videoUrl = pickWebMedia(await fetchSiteHtml(url), vid, sid);
      if (videoUrl) return { url: videoUrl, contentKey: null, codec: '', quality: '', source: 'web', vid: String(vid) };
    } catch (_) { /* try the next form, then the App source */ }
  }
  return null;
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
  if (inWebRange && !skipWeb) {
    const web = await fetchPlayUrlFromWeb(vid, sid);
    if (web) return web;
  }
  let appError = null;
  try {
    return await fetchAppPlayUrl(String(vid));
  } catch (error) { appError = error; /* fall through to an explanatory error */ }
  // A CDN hiccup changes the order of the sources, not whether the website has the episode.
  if (inWebRange && skipWeb) {
    const web = await fetchPlayUrlFromWeb(vid, sid);
    if (web) return web;
  }
  if (appError && appError.network) throw new Error('网络连接失败，未能获取播放地址，请检查电视网络后重试');
  if (!inWebRange) {
    const range = accessible > 0 ? '仅提供前 ' + accessible + ' 集' : '暂未提供可播放分集';
    throw new Error('红果官网当前' + range + '，第 ' + (index + 1) + ' 集暂时无法获取播放地址，请稍后重试。');
  }
  throw new Error('红果官网与备用接口均未提供播放地址，请稍后重试');
}

// A chosen quality needs the App source: the website gives one stream of unknown size.
async function fetchPlayInfoAtQuality(vid, quality) {
  try {
    return await fetchAppPlayUrl(vid, { quality });
  } catch (error) {
    if (error && error.network) throw new Error('网络连接失败，未能获取播放地址，请检查电视网络后重试');
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
