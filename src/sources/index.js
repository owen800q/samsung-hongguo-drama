// Unified source API used by the UI. Series ids: plain digits = 红果,
// 'xifan:<source>:<id>' = 西饭, 'hema:<bookId>' = 河马.
import * as catalog from './catalog.js';
import * as hongguo from './hongguo.js';
import * as xifan from './xifan.js';
import * as hema from './hema.js';

export const SOURCES = [
  { id: 'hongguo', label: '红果' },
  { id: 'xifan', label: '西饭' },
  { id: 'hema', label: '河马' },
];

const ADAPTERS = { hongguo, xifan, hema };

export function sourceOf(seriesId) {
  const id = String(seriesId || '');
  if (id.indexOf('xifan:') === 0) return 'xifan';
  if (id.indexOf('hema:') === 0) return 'hema';
  return 'hongguo';
}

export function sourceLabel(source) {
  const s = SOURCES.find(x => x.id === source);
  return s ? s.label : '';
}

const HONGGUO_CATEGORIES = [
  { slug: 'real-drama', label: '真人剧' },
  { slug: 'comic-drama', label: '漫剧' },
  { slug: 'ai-drama', label: 'AI剧' },
  { slug: 'hot-drama', label: '综合热播榜', group: 'rank' },
  { slug: 'hot-real-drama', label: '真人热播榜', group: 'rank' },
  { slug: 'hot-comic-drama', label: '漫剧热播榜', group: 'rank' },
  { slug: 'hot-ai-drama', label: 'AI热播榜', group: 'rank' },
];

export function browseCategories(source) {
  return source === 'hongguo' || !source ? HONGGUO_CATEGORIES.slice() : [{ slug: '', label: '全部' }];
}

function normalizeList(data, page) {
  if (!data || !data.success) return { success: false, results: [], page, totalPages: 0, hasMore: false, nextPage: null, genres: [], error: (data && data.error) || '加载失败，请重试' };
  return {
    success: true,
    results: data.results || [],
    page: data.page || page,
    totalPages: data.totalPages || 0,
    hasMore: !!data.hasMore,
    nextPage: data.hasMore ? (data.nextPage || (data.page || page) + 1) : null,
    genres: data.genres || [],
    genre: data.genre,
  };
}

export async function browseList(options = {}) {
  const source = options.source || 'hongguo';
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  let data;
  try {
    if (source === 'hongguo') data = await catalog.browseList({ category: options.category, genre: options.genre, page, forceRefresh: options.forceRefresh });
    else if (ADAPTERS[source]) data = await ADAPTERS[source].browseList({ genre: options.genre, page, forceRefresh: options.forceRefresh });
    else data = { success: false, error: '未知来源' };
  } catch (error) {
    data = { success: false, error: error.message };
  }
  return normalizeList(data, page);
}

function interleave(lists) {
  const out = [];
  const max = Math.max.apply(null, [0].concat(lists.map(l => l.length)));
  for (let i = 0; i < max; i++) lists.forEach(l => { if (i < l.length) out.push(l[i]); });
  return out;
}

export async function search(keyword, options = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { success: false, results: [], hasMore: false, nextPage: null, errors: [], error: '请输入搜索关键词' };
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const wanted = !options.source || options.source === 'all' ? SOURCES.map(s => s.id) : [options.source];
  // Hongguo's website only renders the first page of search results.
  const ids = page > 1 ? wanted.filter(id => id !== 'hongguo') : wanted;
  const settled = await Promise.all(ids.map(id =>
    ADAPTERS[id].search(kw, page).catch(error => ({ success: false, error: error.message }))
      .then(res => ({ id, res }))));
  const errors = settled.filter(x => !x.res.success).map(x => ({ source: x.id, error: x.res.error || '搜索失败' }));
  const ok = settled.filter(x => x.res.success);
  let results = interleave(ok.map(x => x.res.results || []));
  const hasMore = ok.some(x => x.res.hasMore);

  if (page === 1 && wanted.indexOf('hongguo') >= 0 && /^\d{6,30}$/.test(kw) && !results.some(r => r.series_id === kw)) {
    try {
      const s = await hongguo.fetchEpisodeList(kw);
      results = [{ series_id: s.series_id, series_title: s.series_title, cover: s.cover, episode_count: s.total, tags: s.tags || [], intro: s.intro, source: 'hongguo' }].concat(results);
    } catch (_) { /* not a valid id: keep text results */ }
  }
  const success = ok.length > 0 || results.length > 0;
  return {
    success, results, page, hasMore, nextPage: hasMore ? page + 1 : null, errors,
    error: success ? undefined : (errors[0] && errors[0].error) || '搜索失败，请重试',
  };
}

export async function fetchSeries(seriesId, options = {}) {
  const source = sourceOf(seriesId);
  const data = source === 'hongguo' ? await hongguo.fetchEpisodeList(seriesId, options) : await ADAPTERS[source].fetchEpisodeList(String(seriesId));
  return {
    series_id: data.series_id,
    series_title: data.series_title,
    cover: data.cover || '',
    intro: data.intro || '',
    tags: data.tags || [],
    total: data.total,
    episodes: data.episodes.map(e => ({ vid: e.vid, vid_index: e.vid_index, title: e.title || '', locked: !!e.locked })),
    source,
    web_accessible_episodes: data.web_accessible_episodes,
  };
}

export async function getPlayInfo(vid, seriesId) {
  const source = sourceOf(seriesId || vid);
  const info = await ADAPTERS[source].fetchPlayInfo(String(vid), seriesId ? String(seriesId) : '');
  if (!info || !info.url) throw new Error('未获取到有效播放地址');
  return info;
}

/** Resolve a typed series id or share link to a 红果 series id. */
export function resolveSeriesId(input) {
  return hongguo.resolveSeriesId(input);
}
