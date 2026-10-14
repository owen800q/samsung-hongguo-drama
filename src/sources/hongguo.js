// 红果 via the official website (hongguoduanju.com). Player pages are server-rendered
// and embed the full episode vid list plus clear MP4 links for the web-accessible range.
import { getText, request, memo } from '../lib/http.js';
import { readRouterData, uniqueBy } from './util.js';
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

function unescapeJson(value) {
  try { return JSON.parse('"' + value + '"'); } catch (_) { return value.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&'); }
}

function pickJsonString(text, key) {
  const m = text.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? unescapeJson(m[1]) : '';
}

function fetchSiteHtml(url) {
  return getText(url, { timeout: 20000, headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
}

async function fetchEpisodeListFromWeb(seriesId) {
  const html = await fetchSiteHtml(SITE + '/player/' + encodeURIComponent(seriesId));
  const m = html.match(/"vid_list"\s*:\s*\[([^\]]*)\]/);
  if (!m) throw new Error('红果官网未返回分集数据，请稍后重试');
  const vids = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(s => /^\d+$/.test(s));
  if (!vids.length) throw new Error('红果分集列表为空');
  const title = pickJsonString(html, 'series_name') || '未命名短剧';
  const cover = pickJsonString(html, 'series_cover');
  const intro = pickJsonString(html, 'series_intro');
  const tagsMatch = html.match(/"tags"\s*:\s*(\[[^\]]*\])/);
  let tags = [];
  try { tags = tagsMatch ? JSON.parse(tagsMatch[1]).filter(t => typeof t === 'string').slice(0, 6) : []; } catch (_) {}
  const accessible = html.match(/"accessible_episode_cnt"\s*:\s*(\d+)/);
  const webAccessible = accessible ? Math.min(Number(accessible[1]), vids.length) : null;
  return {
    series_id: String(seriesId),
    series_title: title,
    cover,
    intro,
    tags,
    total: vids.length,
    web_accessible_episodes: webAccessible,
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
 * player, and the page model must confirm the episode is publicly playable.
 */
export function pickWebMedia(html, vid, sid) {
  let data;
  try { data = (readRouterData(html).loaderData || {})['player_(series_id)/(vid)/page']; } catch (_) { return ''; }
  const actualSid = String((data && data.series_id) || '');
  const seo = data && data.publicVideoSeo;
  if (!data || data.isSuccess === false || String(data.vid) !== String(vid) || !/^\d+$/.test(actualSid) ||
      (sid && actualSid !== String(sid)) || String(data.seriesDetail && data.seriesDetail.series_id) !== actualSid ||
      !seo || seo.available !== true || String(seo.itemId) !== String(vid) || String(seo.seriesId) !== actualSid) return '';
  const matchesPlayer = value => {
    try {
      const target = new URL(value);
      // The first episode's page names the series URL as its canonical address.
      return target.origin === SITE && !target.username && !target.password &&
        (target.pathname === '/player/' + actualSid + '/' + String(vid) || target.pathname === '/player/' + actualSid);
    } catch (_) { return false; }
  };
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = scripts.exec(html))) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(m[1])) continue;
    let video;
    try { video = JSON.parse(m[2]); } catch (_) { continue; }
    if (!video || video['@type'] !== 'VideoObject' || !matchesPlayer(video.url) ||
        (video['@id'] && !matchesPlayer(video['@id']))) continue;
    const url = mediaUrl(normalizeVideoUrl(video.contentUrl));
    if (url) return url;
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
  try {
    return await fetchAppPlayUrl(String(vid));
  } catch (_) { /* fall through to an explanatory error */ }
  // A CDN hiccup changes the order of the sources, not whether the website has the episode.
  if (inWebRange && skipWeb) {
    const web = await fetchPlayUrlFromWeb(vid, sid);
    if (web) return web;
  }
  if (!inWebRange) {
    const range = accessible > 0 ? '仅提供前 ' + accessible + ' 集' : '暂未提供可播放分集';
    throw new Error('红果官网当前' + range + '，第 ' + (index + 1) + ' 集暂时无法获取播放地址，请稍后重试。');
  }
  throw new Error('红果官网与备用接口均未提供播放地址，请稍后重试');
}

/** `options.force` looks the address up again instead of reusing a recent one. */
export function fetchPlayInfo(vid, sid, options = {}) {
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

export async function search(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const html = await fetchSiteHtml(SITE + '/search/' + encodeURIComponent(kw));
    const loader = readRouterData(html).loaderData || {};
    let data = null;
    Object.keys(loader).forEach(k => { if (/^search_/.test(k) && loader[k] && Array.isArray(loader[k].searchList)) data = loader[k]; });
    if (!data) throw new Error('红果搜索数据异常，请稍后重试');
    const results = uniqueBy(data.searchList.map(item => item && item.video_data).filter(v =>
      v && /^\d{6,}$/.test(String(v.series_id)) && typeof v.series_title === 'string' && v.series_title.trim()),
    v => String(v.series_id)).map(v => ({
      series_id: String(v.series_id),
      series_title: v.series_title.trim(),
      cover: typeof v.series_cover === 'string' ? v.series_cover : '',
      episode_count: Number(v.episode_cnt) || 0,
      tags: Array.isArray(v.category_list) ? v.category_list.map(c => c && c.name).filter(t => typeof t === 'string').slice(0, 4) : [],
      intro: typeof v.series_intro === 'string' ? v.series_intro : '',
      heat: v.hot_score_data && typeof v.hot_score_data.text === 'string' ? v.hot_score_data.text : '',
      source: 'hongguo',
    }));
    // The website renders only the first page of results server-side.
    return { success: true, results, page: 1, totalPages: 1, hasMore: false, nextPage: null };
  } catch (error) {
    return { success: false, error: /红果|关键词/.test(error.message) ? error.message : '红果搜索失败，请检查网络后重试' };
  }
}
