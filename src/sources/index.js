// Unified source API used by the UI. Series ids: plain digits = 红果,
// 'xifan:<source>:<id>' = 西饭, 'hema:<bookId>' = 河马.
import * as catalog from './catalog.js';
import * as hongguo from './hongguo.js';
import * as xifan from './xifan.js';
import * as hema from './hema.js';
import { findSequels, hasTitleMatch, rankResults, relaxedQueries, seasonTitle, supplementQueries } from './seasons.js';
import { getSettings } from '../lib/storage.js';

export const SOURCES = [
  { id: 'hongguo', label: '红果' },
  { id: 'xifan', label: '西饭' },
  { id: 'hema', label: '河马' },
];

const ADAPTERS = { hongguo, xifan, hema };

/** The sources not turned off in 设置 (`settings.disabledSources`); 红果 is always on. */
export function enabledSources(settings) {
  const off = (settings || getSettings()).disabledSources;
  return SOURCES.filter(s => s.id === 'hongguo' || !Array.isArray(off) || off.indexOf(s.id) < 0);
}

const SOURCE_OFF = '此来源已关闭，可在设置中重新开启';
const isEnabled = id => enabledSources().some(s => s.id === id);

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
    if (ADAPTERS[source] && !isEnabled(source)) data = { success: false, error: SOURCE_OFF };
    else if (source === 'hongguo') data = await catalog.browseList({ category: options.category, genre: options.genre, page, forceRefresh: options.forceRefresh });
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

async function searchSources(kw, ids, page, deadline) {
  const settled = await Promise.all(ids.map(id =>
    ADAPTERS[id].search(kw, page, { deadline }).catch(error => ({ success: false, error: error.message }))
      .then(res => ({ id, res }))));
  const ok = settled.filter(x => x.res.success);
  return {
    ok: ok.map(x => x.id),
    results: interleave(ok.map(x => (x.res.results || []).map(r => Object.assign({ source: x.id }, r)))),
    more: ok.filter(x => x.res.hasMore && (x.res.results || []).length > 0).map(x => x.id),
    errors: settled.filter(x => !x.res.success).map(x => ({ source: x.id, error: x.res.error || '搜索失败' })),
  };
}

// One search, supplements included, gets 20 s; whatever answered by then is shown.
const SEARCH_BUDGET = 20000;
const MAX_PAGE = 50;

/**
 * Searches the chosen sources. On the first page, a keyword with no title match is searched
 * again without punctuation and spaces, then by its first clause (at most two looser
 * searches, stopping at the first title match; see relaxedQueries). A series name that
 * matches a season title ("剧名第二季") also searches for the lowest missing later season
 * (at most two extra searches, see seasons.js). Results are deduplicated and ranked by
 * title match. Later pages page the original keyword, only on `options.only` (the sources
 * that reported more), up to page 50. `options.afterSeason` starts the season search after
 * a known season.
 */
export async function search(keyword, options = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return { success: false, results: [], hasMore: false, nextPage: null, errors: [], error: '请输入搜索关键词' };
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const deadline = options.deadline || Date.now() + SEARCH_BUDGET;
  const wanted = !options.source || options.source === 'all' ? enabledSources().map(s => s.id) : [options.source];
  // Also covers 查找下一季 on a series from a source turned off since it was watched.
  if (!isEnabled(wanted[0])) return { success: false, results: [], page, hasMore: false, nextPage: null, more: [], errors: [], error: SOURCE_OFF };
  const ids = page > 1 && Array.isArray(options.only) ? wanted.filter(id => options.only.indexOf(id) >= 0) : wanted;
  if (page > MAX_PAGE || !ids.length) return { success: true, results: [], page, hasMore: false, nextPage: null, more: [], errors: [], partial: false, supplementErrors: [], relaxed: [] };
  const primary = await searchSources(kw, ids, page, deadline);
  let results = primary.results;
  const supplementErrors = [];
  const relaxed = [];
  // Only the sources that answered; one that already failed is reported once, in `errors`.
  const supplement = (query, mark) => {
    if (Date.now() >= deadline - 1000) {
      supplementErrors.push({ source: '', error: '搜索时间已用完' });
      return Promise.resolve(false);
    }
    return searchSources(query, primary.ok, 1, deadline).then(extra => {
      results = results.concat(mark ? extra.results.map(r => Object.assign({}, r, { fuzzy: true, fuzzy_query: query })) : extra.results);
      extra.errors.forEach(e => supplementErrors.push(e));
      return true;
    });
  };
  if (page === 1 && primary.ok.length && !/^\d{6,30}$/.test(kw) && !hasTitleMatch(results, kw)) {
    for (const query of relaxedQueries(kw)) {
      if (!(await supplement(query, true))) break;
      relaxed.push(query);
      if (hasTitleMatch(results, kw)) break;
    }
  }
  if (page === 1 && primary.ok.length) {
    for (const query of supplementQueries(kw, results, options.known, options.afterSeason)) {
      if (!(await supplement(query, false))) break;
    }
  }
  results = rankResults(results, kw);

  if (page === 1 && wanted.indexOf('hongguo') >= 0 && /^\d{6,30}$/.test(kw) && !results.some(r => r.series_id === kw)) {
    try {
      const s = await hongguo.fetchEpisodeList(kw);
      results = [{ series_id: s.series_id, series_title: s.series_title, cover: s.cover, episode_count: s.total, tags: s.tags || [], intro: s.intro, source: 'hongguo', relevance: 0 }].concat(results);
    } catch (_) { /* not a valid id: keep text results */ }
  }
  const success = primary.ok.length > 0 || results.length > 0;
  const errors = primary.errors;
  // A source whose later page failed keeps its place, so the next load retries that page.
  const more = page >= MAX_PAGE ? [] : page > 1 ? primary.more.concat(errors.map(e => e.source)) : primary.more;
  return {
    success, results, page, hasMore: more.length > 0, nextPage: more.length ? page + 1 : null, more, errors,
    partial: supplementErrors.length > 0, supplementErrors, relaxed,
    error: success ? undefined : (errors[0] && errors[0].error) || '搜索失败，请重试',
  };
}

/**
 * Possible later seasons of a series, from its own source only: `local` (watch history and
 * 追剧 entries) plus a search for the base title. Candidates are for the user to check;
 * nothing is played automatically. A failed search keeps the local candidates.
 */
export async function findNextSeasons(series, local = []) {
  const parsed = seasonTitle(series && series.series_title);
  if (!parsed.base || parsed.invalid || parsed.season > 99) return { success: false, results: [], error: '剧名或季数无法识别，请按完整剧名搜索。' };
  const known = findSequels(series, local, sourceOf);
  try {
    const res = await search(parsed.base, { source: sourceOf(series.series_id), afterSeason: parsed.season, known: [series].concat(known), deadline: Date.now() + 22000 });
    if (!res.success) throw new Error(res.error || '来源搜索失败');
    const results = findSequels(series, known.concat(res.results), sourceOf);
    return res.partial ? { success: true, results, partial: true, error: '补充搜索未完成，可稍后重试。' } : { success: true, results };
  } catch (error) {
    return { success: known.length > 0, results: known, partial: true,
      error: '联网查找未完成：' + (error.message || '来源搜索失败') + (known.length ? '；已保留本机记录中的候选。' : '；可稍后重试。') };
  }
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

/** `options.force` bypasses cached addresses (西饭 and 河马 never cache them). */
export async function getPlayInfo(vid, seriesId, options = {}) {
  const source = sourceOf(seriesId || vid);
  const info = await ADAPTERS[source].fetchPlayInfo(String(vid), seriesId ? String(seriesId) : '', options);
  if (!info || !info.url) throw new Error('未获取到有效播放地址');
  return info;
}

/** A 红果 website address failed to play: prefer the App source for it for a while. */
export function markWebMediaFailure(vid, seriesId) {
  if (sourceOf(seriesId || vid) === 'hongguo') hongguo.markWebMediaFailure(String(vid));
}

/** Resolve a typed series id or share link to a 红果 series id. */
export function resolveSeriesId(input) {
  return hongguo.resolveSeriesId(input);
}
