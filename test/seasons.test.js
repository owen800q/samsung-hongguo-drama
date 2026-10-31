import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonTitle, seasonQueries, supplementQueries, rankResults, findSequels } from '../src/sources/seasons.js';
import { sourceOf } from '../src/sources/index.js';

test('season titles: Chinese, digit, bracket and English markers', () => {
  assert.deepEqual(seasonTitle('贞观憨婿第二季'), { base: '贞观憨婿', season: 2, explicit: true });
  assert.deepEqual(seasonTitle('小草修仙记 第 12 季'), { base: '小草修仙记', season: 12, explicit: true });
  assert.deepEqual(seasonTitle('大话（三）'), { base: '大话', season: 3, explicit: true });
  assert.deepEqual(seasonTitle('Love Season 4'), { base: 'love', season: 4, explicit: true });
  assert.equal(seasonTitle('剧名第二十一季').season, 21);
  assert.equal(seasonTitle('剧名第十季').season, 10);
  assert.equal(seasonTitle('剧名第一百零二部').season, 102);
  assert.deepEqual(seasonTitle('贞观憨婿'), { base: '贞观憨婿', season: 1, explicit: false });
  // A bracketed year is not a season; a zero season is unreadable.
  assert.deepEqual(seasonTitle('剧名(2024)'), { base: '剧名(2024)', season: 1, explicit: false });
  assert.equal(seasonTitle('剧名第零季').invalid, true);
});

test('season queries spell the season both ways', () => {
  assert.deepEqual(seasonQueries('剧', 2), ['剧第二季', '剧第2季']);
  assert.deepEqual(seasonQueries('剧', 10), ['剧第十季', '剧第10季']);
  assert.deepEqual(seasonQueries('剧', 23), ['剧第二十三季', '剧第23季']);
  assert.deepEqual(seasonQueries('剧', 1), []);
  assert.deepEqual(seasonQueries('剧', 100), []);
});

test('supplement searches: lowest missing later season, or the bare name for an unmatched season', () => {
  const r = titles => titles.map((t, i) => ({ series_id: String(i + 1), series_title: t }));
  assert.deepEqual(supplementQueries('剧', r(['剧', '剧第二季'])), ['剧第三季', '剧第3季']);
  assert.deepEqual(supplementQueries('剧', r(['剧第三季'])), ['剧第二季', '剧第2季']);
  assert.deepEqual(supplementQueries('剧', r(['别的剧'])), []);
  assert.deepEqual(supplementQueries('剧', r(['剧第二季']), [], 2), ['剧第三季', '剧第3季']);
  assert.deepEqual(supplementQueries('剧第三季', r(['剧第二季'])), ['剧']);
  assert.deepEqual(supplementQueries('剧第三季', r(['剧 第三季'])), []);
});

test('ranking keeps source order inside each tier and drops duplicates per source', () => {
  const ranked = rankResults([
    { series_id: '1', series_title: '无关', source: 'hongguo' },
    { series_id: '2', series_title: '剧名第二季', source: 'hongguo' },
    { series_id: 'xifan:a:1', series_title: '剧名', source: 'xifan' },
    { series_id: '2', series_title: '剧名第二季', source: 'hongguo' },
    { series_id: '3', series_title: '剧名第三季', source: 'hongguo' },
    { series_id: '4', series_title: '', source: 'hongguo' },
  ], '剧名');
  assert.deepEqual(ranked.map(x => x.series_id + ':' + x.relevance), ['xifan:a:1:0', '2:1', '3:1', '1:2']);
});

test('sequels: same source, same base, higher explicit season, in season order', () => {
  const series = { series_id: '100', series_title: '剧名第二季' };
  const found = findSequels(series, [
    { series_id: '104', series_title: '剧名第四季' },
    { series_id: '101', series_title: '剧名' },
    { series_id: '103', series_title: '剧名第三季' },
    { series_id: '100', series_title: '剧名第二季' },
    { series_id: 'xifan:a:1', series_title: '剧名第三季' },
    { series_id: '105', series_title: '别名第三季' },
    { series_id: '103', series_title: '剧名第三季' },
  ], sourceOf);
  assert.deepEqual(found.map(x => x.series_id), ['103', '104']);
  assert.deepEqual(findSequels({ series_id: '1', series_title: '剧名第零季' }, [{ series_id: '2', series_title: '剧名第二季' }], sourceOf), []);
});

test('upstream 5.0 season spellings: no 第, bracketed seasons and 部', () => {
  for (const suffix of ['第2季', '第二季', '2季', '二季', '二部', '（第二季）', '(2部)', '(第2部)', 'season 2']) {
    assert.deepEqual(seasonTitle('游戏入侵' + suffix), { base: '游戏入侵', season: 2, explicit: true }, suffix);
  }
  // Years, zero, large bare numbers and a whole title that is only a number stay plain titles.
  for (const title of ['剧名（2024）', '剧名(0)', '剧名(100)', '剧名(二〇二四)', '剧名(一百)', '剧名2024部', '四季', '(第三季)']) {
    assert.equal(seasonTitle(title).explicit, false, title);
  }
  assert.equal(seasonTitle('剧名第0季').invalid, true);
  assert.equal(seasonTitle('剧名第一百零二部').season, 102);
  const series = { series_id: '200', series_title: '游戏入侵' };
  assert.deepEqual(findSequels(series, [
    { series_id: '202', series_title: '游戏入侵(3部)' },
    { series_id: '201', series_title: '游戏入侵2季' },
  ], sourceOf).map(s => s.series_id), ['201', '202']);
});
