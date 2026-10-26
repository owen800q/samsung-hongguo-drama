// 河马 (kuaikaw.cn): Next.js pages embed __NEXT_DATA__; search is a JSON endpoint.
import { request } from '../lib/http.js';
import { plainText, httpsUrl, uniqueBy } from './util.js';

const ORIGIN = 'https://www.kuaikaw.cn';
const ID = /^\d{1,30}$/;
let genreCache = null;

function parseId(value, episode) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'hema' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every(p => ID.test(p))) {
    throw new Error('河马剧集编号无效');
  }
  return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(':') };
}

/** `deadline` (ms timestamp, optional) shortens the request to the time a search has left. */
async function call(path, body, deadline) {
  const left = deadline ? deadline - Date.now() : 12000;
  if (left < 1000) throw new Error('河马加载超时，请重试');
  try {
    const res = await request(ORIGIN + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json', pname: 'www.kuaikaw.cn' } : { Accept: 'text/html' },
      body: body ? JSON.stringify(body) : null,
      responseType: body ? 'json' : 'text',
      timeout: Math.min(12000, left),
    });
    return res.data;
  } catch (error) {
    throw new Error(error && error.message === '请求超时' ? '河马加载超时，请重试' : '河马来源暂不可用，请稍后重试');
  }
}

function normalizeBooks(books) {
  return uniqueBy(books.filter(item => item && ID.test(String(item.bookId || '')) && plainText(item.bookName)).map(item => ({
    series_id: 'hema:' + item.bookId,
    series_title: plainText(item.bookName),
    cover: httpsUrl(item.coverWap),
    episode_count: Number(item.totalChapterNum) || 0,
    tags: Array.isArray(item.bookTypeThree) ? item.bookTypeThree.map(t => plainText(t && t.name)).filter(Boolean).slice(0, 4) : [],
    intro: plainText(item.introduction || ''),
    source: 'hema',
  })), item => item.series_id);
}

function nextData(html, message) {
  const m = typeof html === 'string' && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  try {
    const data = JSON.parse(m[1]).props.pageProps;
    if (!data || typeof data !== 'object') throw new Error('invalid');
    return data;
  } catch (_) { throw new Error(message); }
}

export async function browseList(options = {}) {
  try {
    const pg = Number(options.page || 1);
    const slug = String(options.genre || '0');
    if (!Number.isSafeInteger(pg) || pg < 1 || !/^\d{1,30}(?:-\d{1,30}){0,15}$/.test(slug)) throw new Error('河马题材或页码无效，请重新选择');
    let firstHtml;
    if (options.forceRefresh || !genreCache || genreCache.expires <= Date.now()) {
      firstHtml = await call('/browse');
      const dir = nextData(firstHtml, '河马目录数据异常，请稍后重试');
      if (!Array.isArray(dir.typeThreeList)) throw new Error('河马没有返回可用题材，请重试');
      const items = uniqueBy(dir.typeThreeList.filter(item => item && Array.isArray(item.typeThreeIds)
        && item.typeThreeIds.length > 0 && item.typeThreeIds.length <= 16
        && item.typeThreeIds.every(id => ID.test(String(id))) && plainText(item.name))
        .map(item => ({ slug: item.typeThreeIds.join('-'), label: plainText(item.name) }))
        .filter(item => item.slug !== '0'), item => item.slug);
      if (!items.length) throw new Error('河马没有返回可用题材，请重试');
      genreCache = { items, expires: Date.now() + 300000 };
    }
    if (slug !== '0' && !genreCache.items.some(item => item.slug === slug)) throw new Error('河马题材无效，请重新选择');
    const path = slug === '0' && pg === 1 ? '/browse' : '/browse/' + slug + (pg > 1 ? '/' + pg : '');
    const html = path === '/browse' && firstHtml ? firstHtml : await call(path);
    const data = nextData(html, '河马目录数据异常，请稍后重试');
    if (!Array.isArray(data.bookList) || Number(data.page) !== pg || String(data.typeThreeId || '0') !== slug) {
      throw new Error('河马返回的目录与请求不一致，请重试');
    }
    const results = normalizeBooks(data.bookList);
    const hasMore = results.length > 0 && new RegExp('<a\\b[^>]*\\shref=["\']/browse/' + slug + '/' + (pg + 1) + '["\']').test(html);
    return {
      success: true, results, page: pg, totalPages: 0, hasMore, nextPage: hasMore ? pg + 1 : null,
      genres: [{ slug: '', label: '全部' }].concat(genreCache.items),
    };
  } catch (error) { return { success: false, error: error.message }; }
}

export async function search(keyword, page = 1, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const res = await call('/seo/video/6007', { sourceType: 1, keyword: kw, index: pg }, options.deadline);
    if (!res || res.retCode !== 0 || !res.data || !Array.isArray(res.data.bookList)) throw new Error('河马搜索数据异常，请稍后重试');
    const results = normalizeBooks(res.data.bookList);
    const hasMore = res.data.isMore === 1 && results.length > 0;
    return { success: true, results, page: pg, totalPages: 0, hasMore, nextPage: hasMore ? pg + 1 : null, genres: [] };
  } catch (error) { return { success: false, error: error.message }; }
}

async function detail(seriesId) {
  const { bookId } = parseId(seriesId, false);
  const result = nextData(await call('/drama/' + bookId), '河马详情数据异常，请稍后重试');
  if (!result.bookInfoVo || String(result.bookInfoVo.bookId) !== bookId || !Array.isArray(result.chapterList)) {
    throw new Error('河马返回的剧集与请求不一致');
  }
  const seen = new Set();
  for (const ep of result.chapterList) {
    const id = String((ep && ep.chapterId) || '');
    if (!ID.test(id) || seen.has(id) || (ep.bookId != null && String(ep.bookId) !== bookId)) throw new Error('河马分集数据异常，请稍后重试');
    seen.add(id);
  }
  return result;
}

export async function fetchEpisodeList(seriesId) {
  const result = await detail(seriesId);
  const info = result.bookInfoVo;
  const episodes = result.chapterList.map((ep, i) => ({
    vid: seriesId + ':' + ep.chapterId, vid_index: Number(ep.chapterIndex) || i + 1,
    title: plainText(ep.chapterName), locked: ep.isCharge !== '0',
  })).sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('河马分集列表为空');
  return {
    series_id: seriesId, series_title: plainText(info.bookName) || '未命名短剧', cover: httpsUrl(info.coverWap),
    intro: plainText(info.introduction || ''),
    tags: Array.isArray(info.bookTypeThree) ? info.bookTypeThree.map(t => plainText(t && t.name)).filter(Boolean).slice(0, 6) : [],
    total: episodes.length, episodes, source: 'hema',
  };
}

export async function fetchPlayInfo(vid, sid) {
  const id = parseId(vid, true);
  if (sid != null && sid !== '' && parseId(sid, false).seriesId !== id.seriesId) throw new Error('河马分集不属于当前剧集');
  // Re-read the public detail every time: never reuse a cached free/paid decision.
  const result = await detail(id.seriesId);
  const ep = result.chapterList.find(item => String(item.chapterId) === id.chapterId);
  if (!ep) throw new Error('河马未找到该分集');
  if (ep.isCharge !== '0') throw new Error('第 ' + (Number(ep.chapterIndex) || '') + ' 集当前锁定，请在河马官方平台确认可看范围');
  const v = ep.chapterVideoVo || {};
  const url = httpsUrl(v.mp4720p) || httpsUrl(v.mp4);
  if (!url) throw new Error('河马未提供有效播放地址');
  return { url, contentKey: null, codec: '', quality: httpsUrl(v.mp4720p) ? '720p' : '', source: 'hema' };
}
