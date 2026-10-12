// 红果 catalog and ranking pages (hongguoduanju.com, server-rendered).
import { getText } from '../lib/http.js';
import { readRouterData, decodeHtml, uniqueBy } from './util.js';

const SITE = 'https://hongguoduanju.com';
export const CATEGORIES = ['real-drama', 'comic-drama', 'ai-drama'];
export const RANKINGS = ['hot-drama', 'hot-real-drama', 'hot-comic-drama', 'hot-ai-drama'];
const CACHE_MS = 30000;
const cache = new Map();
const pending = new Map();

function parseCatalog(html, category, page) {
  const router = readRouterData(html);
  const loader = router.loaderData || {};
  let data = null;
  Object.keys(loader).forEach(k => {
    const v = loader[k];
    if (v && v.categoryRoute && v.categoryRoute.contentType === category) data = v;
  });
  if (!data || data.isSuccess === false || !Array.isArray(data.recommendList)) {
    throw new Error('红果目录暂不可用，请稍后重试');
  }
  const results = uniqueBy(data.recommendList.filter(item =>
    item && /^\d{6,}$/.test(item.series_id) && typeof item.series_name === 'string' && item.series_name.trim()),
  item => String(item.series_id)).map(item => ({
    series_id: String(item.series_id),
    series_title: item.series_name.trim(),
    cover: item.series_cover || '',
    episode_count: Number(item.episode_cnt) || 0,
    tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string').slice(0, 4) : [],
    intro: typeof item.series_intro === 'string' ? item.series_intro : '',
    source: 'hongguo',
  }));
  const genres = [];
  (Array.isArray(data.selectorList) ? data.selectorList : []).forEach(row => {
    (row && Array.isArray(row.items) ? row.items : []).forEach(item => {
      if (item && /^[a-z0-9-]+$/.test(item.selector_item_id) && typeof item.show_name === 'string') {
        genres.push({ slug: item.selector_item_id, label: item.show_name });
      }
    });
  });
  const pg = (data.pagination && Number(data.pagination.pageNum)) || page;
  const totalPages = (data.pagination && Number(data.pagination.totalPages)) || 0;
  return { success: true, results, page: pg, totalPages, genres };
}

function parseRanking(html, category, page) {
  const text = value => decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).trim();
  let data;
  for (const script of String(html).matchAll(/<script\b([^>]*)>/gi)) {
    if (!/data-fn-name=["']mergeLoaderData["']/.test(script[1])) continue;
    const encoded = script[1].match(/data-fn-args=(?:"([^"]*)"|'([^']*)')/);
    if (!encoded) continue;
    try {
      const args = JSON.parse(decodeHtml(encoded[1] != null ? encoded[1] : encoded[2]));
      if (args[0] !== 'rank_' + category + '/page' || !Array.isArray(args[1])) continue;
      const content = args[1].find(item => item.key === 'content' && item.routerDataFnName === 'p');
      if (content && content.routerDataFnArgs && content.routerDataFnArgs[0]) data = JSON.parse(content.routerDataFnArgs[0]);
    } catch (_) { /* some streamed responses only expose rendered cards */ }
  }
  const seen = new Set();
  const normalize = item => {
    const id = String(item.seriesId || '');
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const rank = Number(item.rank);
    if (!/^\d{6,}$/.test(id) || !title || !(rank >= 1) || Math.floor(rank) !== rank || seen.has(id)) return null;
    seen.add(id);
    return {
      series_id: id, series_title: title,
      cover: typeof item.cover === 'string' && /^https?:\/\//.test(item.cover) ? item.cover : '',
      episode_count: Array.isArray(item.episodeVids) ? item.episodeVids.length : 0,
      tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string').slice(0, 4) : [],
      rank, heat: typeof item.heatText === 'string' ? item.heatText.trim() : '', source: 'hongguo',
    };
  };
  let results = data && data.isSuccess !== false && Array.isArray(data.rankList) ? data.rankList.map(normalize).filter(Boolean) : [];
  if (!results.length) {
    for (const match of String(html).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
      const article = match[1];
      const heading = article.match(/<h2\b[^>]*\bid=["']rank-title-(\d+)["'][^>]*>([\s\S]*?)<\/h2>/i);
      if (!heading || article.indexOf('/detail?series_id=' + heading[1]) < 0) continue;
      const cover = article.match(/<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)')/i);
      const tags = article.match(/<p\b[^>]*class=["'][^"']*pc-categories-[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
      const rankMatch = article.match(/<span\b[^>]*>\s*(\d+)\s*<\/span>/i);
      const heat = text(article).match(/[\d.,]+\s*[万亿]?\s*热度/);
      const item = normalize({
        seriesId: heading[1], title: text(heading[2]), rank: rankMatch && rankMatch[1],
        heatText: heat ? heat[0] : '',
        cover: cover ? decodeHtml(cover[1] != null ? cover[1] : cover[2]) : '',
        tags: tags ? Array.from(tags[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi), t => text(t[1])) : [],
      });
      if (item) results.push(item);
    }
  }
  if (!results.length) throw new Error('红果榜单暂不可用，请稍后重试');
  const navMatch = String(html).match(/<nav\b[^>]*aria-label=["']榜单分页["'][^>]*>([\s\S]*?)<\/nav>/i);
  const nav = navMatch ? navMatch[1] : '';
  const cur = nav.match(/aria-current=["']page["'][^>]*>(\d+)/);
  const current = (data && data.pagination && Number(data.pagination.pageNum)) || (cur && Number(cur[1])) || page;
  const pages = Array.from(nav.matchAll(/href=["']([^"']+)["']/g), m => {
    try {
      const url = new URL(decodeHtml(m[1]), SITE);
      return url.origin === SITE && url.pathname === '/rank/' + category ? Number(url.searchParams.get('page')) || 1 : 0;
    } catch (_) { return 0; }
  });
  const totalPages = (data && data.pagination && Number(data.pagination.totalPages)) || Math.max.apply(null, [current].concat(pages));
  return { success: true, results, page: current, totalPages, genres: [] };
}

export function browseList(options = {}) {
  const category = options.category || 'real-drama';
  const genre = options.genre || '';
  const ranking = RANKINGS.indexOf(category) >= 0;
  if ((CATEGORIES.indexOf(category) < 0 && !ranking) || (genre && (!/^[a-z0-9-]+$/.test(genre) || ranking))) {
    return Promise.resolve({ success: false, error: '无效的目录分类或题材' });
  }
  const pg = Math.max(1, parseInt(options.page, 10) || 1);
  const url = SITE + '/' + (ranking ? 'rank' : 'category') + '/' + category + (genre ? '/' + genre : '') + (pg > 1 ? '?page=' + pg : '');
  const hit = cache.get(url);
  if (!options.forceRefresh && hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  if (pending.has(url)) return pending.get(url);
  const task = getText(url, { timeout: 12000 }).then(html => {
    const data = (ranking ? parseRanking : parseCatalog)(html, category, pg);
    data.hasMore = data.page < data.totalPages && data.results.length > 0;
    data.nextPage = data.hasMore ? data.page + 1 : null;
    cache.set(url, { expires: Date.now() + CACHE_MS, data });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    return data;
  }).catch(error => ({
    success: false,
    error: error && error.message === '请求超时' ? '目录加载超时，请重试' : (error && /红果|目录|榜单|来源/.test(error.message) ? error.message : '红果目录加载失败，请检查网络后重试'),
  })).finally(() => pending.delete(url));
  pending.set(url, task);
  return task;
}
