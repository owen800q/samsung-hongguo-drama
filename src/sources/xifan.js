// 西饭 public JSON API.
import { getJson, withQuery } from '../lib/http.js';
import { plainText, httpsUrl, uniqueBy } from './util.js';
import { utf8, toHex } from '../lib/bytes.js';

const API = 'https://xifan-api-cn.youlishipin.com';
const ID = /^[a-zA-Z0-9_-]{1,200}$/;
let genreCache = null;

function parseId(value, episode) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'xifan' || parts.length !== (episode ? 4 : 3) || !parts.slice(1).every(p => ID.test(p))) {
    throw new Error('西饭剧集编号无效');
  }
  return { source: parts[1], duanjuId: parts[2], episodeId: parts[3], seriesId: parts.slice(0, 3).join(':') };
}

/** `deadline` (ms timestamp, optional) shortens the request to the time a search has left. */
async function call(path, params, deadline) {
  const left = deadline ? deadline - Date.now() : 12000;
  if (left < 1000) throw new Error('西饭加载超时，请重试');
  let data;
  try {
    data = await getJson(withQuery(API + path, Object.assign({}, params, { version: 2001001, androidVersionCode: 28 })),
      { timeout: Math.min(12000, left), headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new Error(error && error.message === '请求超时' ? '西饭加载超时，请重试' : '西饭来源暂不可用，请稍后重试');
  }
  if (!data || data.ret !== 0 || !data.result || typeof data.result !== 'object') throw new Error('西饭来源暂不可用，请稍后重试');
  return data.result;
}

function contents(result) {
  return (Array.isArray(result.elements) ? result.elements : []).flatMap(el => (el && Array.isArray(el.contents) ? el.contents : []));
}

async function genres(force) {
  if (!force && genreCache && genreCache.expires > Date.now()) return genreCache.items;
  const result = await call('/xifan/drama/portalPage', { reqType: 'duanjuCategory' });
  const items = uniqueBy(contents(result).flatMap(item => {
    const c = item.categoryItemVo;
    return c ? (Array.isArray(c.subCategories) ? c.subCategories : [c]) : [];
  }).filter(item => Number.isSafeInteger(item.categoryId) && item.categoryId > 0 && plainText(item.oppoCategory))
    .map(item => ({
      slug: item.categoryId + '-' + toHex(utf8(item.oppoCategory)),
      label: plainText(item.oppoCategory), categoryId: item.categoryId, version: Number(item.version) || 1,
    })), item => item.slug);
  if (!items.length) throw new Error('西饭没有返回可用分类，请重试');
  genreCache = { expires: Date.now() + 300000, items };
  return items;
}

function normalizeList(result, page, categoryItems) {
  const results = uniqueBy(contents(result).map(item => item.duanjuVo)
    .filter(item => item && ID.test(String(item.source || '')) && ID.test(String(item.duanjuId || '')) && plainText(item.title))
    .map(item => ({
      series_id: 'xifan:' + item.source + ':' + item.duanjuId,
      series_title: plainText(item.title),
      cover: httpsUrl(item.coverImageUrl),
      episode_count: Number(item.total) || 0,
      tags: Array.isArray(item.categories) ? item.categories.map(plainText).filter(Boolean).slice(0, 4) : [],
      source: 'xifan',
    })), item => item.series_id);
  const hasMore = result.hasMore === true && results.length > 0;
  return {
    success: true, results, page, totalPages: 0, hasMore, nextPage: hasMore ? page + 1 : null,
    genres: (categoryItems || []).map(g => ({ slug: g.slug, label: g.label })),
  };
}

export async function browseList(options = {}) {
  try {
    const pg = Math.max(1, parseInt(options.page, 10) || 1);
    const items = await genres(options.forceRefresh);
    const selected = options.genre ? items.find(i => i.slug === options.genre) : (items.find(i => i.label === '都市') || items[0]);
    if (!selected) throw new Error('西饭题材无效，请重新选择');
    const result = await call('/xifan/drama/portalPage', {
      reqType: 'aggregationPage', offset: (pg - 1) * 30,
      categoryId: selected.categoryId, categoryNames: selected.label, categoryVersion: selected.version,
    });
    const data = normalizeList(result, pg, items);
    data.genre = selected.slug;
    return data;
  } catch (error) { return { success: false, error: error.message }; }
}

export async function search(keyword, page = 1, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const pg = Math.max(1, parseInt(page, 10) || 1);
    return normalizeList(await call('/xifan/search/getSearchList', { keyword: kw, pageIndex: pg }, options.deadline), pg, []);
  } catch (error) { return { success: false, error: error.message }; }
}

async function detail(seriesId) {
  const id = parseId(seriesId, false);
  const result = await call('/xifan/drama/getDuanjuInfo', { source: id.source, duanjuId: id.duanjuId });
  if (result.source !== id.source || String(result.duanjuId) !== id.duanjuId || !Array.isArray(result.episodeList)) {
    throw new Error('西饭返回的剧集与请求不一致');
  }
  return result;
}

export async function fetchEpisodeList(seriesId) {
  const result = await detail(seriesId);
  const title = plainText(result.title) || '未命名短剧';
  const episodes = result.episodeList.filter(e => ID.test(String(e.episodeId || ''))).map(e => ({
    vid: seriesId + ':' + e.episodeId, vid_index: Number(e.index) || 0, title: plainText(e.title), locked: e.unlock !== true,
  })).sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('西饭分集列表为空');
  return {
    series_id: seriesId, series_title: title, cover: httpsUrl(result.coverImageUrl),
    intro: plainText(result.introduction || result.desc || result.description || ''),
    tags: Array.isArray(result.categories) ? result.categories.map(plainText).filter(Boolean).slice(0, 6) : [],
    total: episodes.length, episodes, source: 'xifan',
  };
}

export async function fetchPlayInfo(vid, sid) {
  const id = parseId(vid, true);
  if (sid && String(sid) !== id.seriesId) throw new Error('西饭分集不属于当前剧集');
  // Always re-read access state: never reuse a cached free/locked decision.
  const result = await detail(id.seriesId);
  const ep = result.episodeList.find(item => String(item.episodeId) === id.episodeId);
  if (!ep) throw new Error('西饭未找到该分集');
  if (ep.unlock !== true) throw new Error('第 ' + (Number(ep.index) || '') + ' 集当前锁定，请在西饭官方 App 确认可看范围');
  const url = httpsUrl(ep.playUrl);
  if (!url) throw new Error('西饭未提供有效播放地址');
  return { url, contentKey: null, codec: '', quality: '', source: 'xifan' };
}
