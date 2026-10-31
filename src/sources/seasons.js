// Season-aware title helpers (ported from upstream 3.1 watch-history / series-search):
// parse "剧名第二季" style titles, rank search results by title match, and pick sequels.

const DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function normalizeTitle(title) {
  return String(title || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (!/[十百]/.test(value)) return Number(value.split('').map(c => DIGITS[c]).join(''));
  let n = 0, digit = 0;
  for (const c of value) {
    if (c === '百') { n += (digit || 1) * 100; digit = 0; } else if (c === '十') { n += (digit || 1) * 10; digit = 0; } else digit = DIGITS[c] || 0;
  }
  return n + digit;
}

/**
 * `{ base, season, explicit }`: "大话第二季" → { base: '大话', season: 2, explicit: true }; a title
 * without a season marker is season 1 and not explicit. `invalid` marks an unreadable number.
 */
export function seasonTitle(title) {
  const text = normalizeTitle(title);
  // Upstream 5.0 also reads "2季", "二部", "（第二季）" and "(2部)".
  const m = text.match(/^(.*?)(?:(第)?([一二三四五六七八九十百零两\d]+)[季部]|[（(](?:第)?([一二三四五六七八九十百零两\d]+)(?:[季部])?[）)]|season(\d+))$/i);
  if (!m) return { base: text, season: 1, explicit: false };
  const season = chineseNumber(m[3] || m[4] || m[5]);
  // Bracket numbers and a number without 第 can be years or other title metadata; accept only
  // modest season numbers there, and never a whole title like "四季".
  if ((m[4] || (m[3] && !m[2])) && (season > 99 || !m[1])) return { base: text, season: 1, explicit: false };
  if (!Number.isSafeInteger(season) || season < 1) return { base: text, season: 1, explicit: false, invalid: true };
  return { base: m[1], season, explicit: true };
}

/** Search terms for one season: "剧名第二季" and "剧名第2季". */
export function seasonQueries(base, season) {
  if (!base || !Number.isInteger(season) || season < 2 || season > 99) return [];
  const d = '零一二三四五六七八九';
  const chinese = season < 10 ? d[season] : (season < 20 ? '' : d[Math.floor(season / 10)]) + '十' + (season % 10 ? d[season % 10] : '');
  return [base + '第' + chinese + '季', base + '第' + season + '季'];
}

/**
 * Extra searches for a keyword given the results it found (at most two). A plain series name
 * whose results include a season of it asks for the lowest season not yet found after
 * `afterSeason`; an explicit season the results do not contain falls back to the bare name.
 */
export function supplementQueries(keyword, results, known, afterSeason) {
  const parsed = seasonTitle(keyword);
  if (!parsed.base || parsed.invalid || parsed.season > 99) return [];
  if (parsed.explicit) return results.some(r => normalizeTitle(r.series_title) === normalizeTitle(keyword)) ? [] : [parsed.base];
  const seasons = results.concat(known || []).map(r => seasonTitle(r.series_title)).filter(s => s.base === parsed.base && !s.invalid);
  if (!seasons.length) return [];
  const have = new Set(seasons.map(s => s.season));
  let next = (afterSeason || 1) + 1;
  while (next <= 99 && have.has(next)) next++;
  return seasonQueries(parsed.base, next);
}

// Whitespace, punctuation and symbols (after NFKC, so full-width forms are already ASCII).
// Spelled out because Chromium 56 has no \p{P} / \p{S} regex classes.
const PUNCT = /[\s!-\/:-@\[-`{-~\u00a1-\u00bf\u00d7\u00f7\u2000-\u206f\u2100-\u2bff\u3000-\u3004\u3008-\u3020\u3030-\u303f\u30fb\ufe10-\ufe1f\ufe30-\ufe4f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\uffe0-\uffee]+/g;

/** Title text for matching: full-/half-width, case, spaces and punctuation do not count. */
export function searchText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(PUNCT, '');
}

/**
 * Looser searches for a keyword whose results have no title match (at most two): the
 * keyword without punctuation and spaces, then its first clause of two or more characters.
 * "言出法随，诸天万界我说了算" → ["言出法随诸天万界我说了算", "言出法随"].
 */
export function relaxedQueries(keyword) {
  const text = String(keyword || '').normalize('NFKC').trim();
  const stripped = text.replace(PUNCT, '');
  const out = [];
  if (stripped && stripped !== text) out.push(stripped);
  const first = text.split(PUNCT).filter(part => part.length >= 2)[0];
  if (first && first !== text && out.indexOf(first) < 0) out.push(first);
  return out.slice(0, 2);
}

/** 0 = exact title, 1 = title contains the keyword, 2 = another result the source returned. */
export function relevance(title, keyword) {
  const t = searchText(title), k = searchText(keyword);
  return !k ? 2 : t === k ? 0 : t.indexOf(k) >= 0 ? 1 : 2;
}

export function hasTitleMatch(results, keyword) {
  return results.some(r => r && relevance(r.series_title, keyword) < 2);
}

/**
 * Drop duplicates (per source) and untitled entries; stable-sort by title relevance. Among
 * the other results, those found by a looser search (`fuzzy`) come first.
 */
export function rankResults(results, keyword) {
  const seen = new Set();
  return results.filter(r => {
    const key = (r && r.source) + ':' + (r && r.series_id);
    if (!r || !r.series_id || !r.series_title || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((r, i) => ({ r, i, rel: relevance(r.series_title, keyword) }))
    .sort((a, b) => a.rel - b.rel || (a.rel === 2 && !!a.r.fuzzy !== !!b.r.fuzzy ? (a.r.fuzzy ? -1 : 1) : 0) || a.i - b.i)
    .map(x => Object.assign({}, x.r, { relevance: x.rel }));
}

/** Later seasons of `series` among `candidates`: same source, same base title, higher explicit season. */
export function findSequels(series, candidates, sourceOf) {
  const current = seasonTitle(series.series_title);
  const source = sourceOf(String(series.series_id));
  if (!current.base || current.invalid) return [];
  const seen = new Set([String(series.series_id)]);
  return candidates.filter(c => {
    const id = String(c.series_id || '');
    const next = seasonTitle(c.series_title);
    if (!id || seen.has(id) || sourceOf(id) !== source || !next.explicit || next.invalid || next.base !== current.base || next.season <= current.season) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => seasonTitle(a.series_title).season - seasonTitle(b.series_title).season).slice(0, 10);
}
