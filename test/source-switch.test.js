import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = { localStorage: {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
} };
const { saveSettings } = await import('../src/lib/storage.js');
const { enabledSources, browseList, search, findNextSeasons } = await import('../src/sources/index.js');

const ids = list => list.map(s => s.id);

test('every source is on by default and 红果 cannot be turned off', () => {
  store.clear();
  assert.deepEqual(ids(enabledSources()), ['hongguo', 'xifan', 'hema']);
  saveSettings({ disabledSources: ['hongguo', 'hema'] });
  assert.deepEqual(ids(enabledSources()), ['hongguo', 'xifan']);
  assert.deepEqual(ids(enabledSources({ disabledSources: 'hema' })), ['hongguo', 'xifan', 'hema']);
});

// These run without a transport: a source that is off answers before any request.
test('a source turned off is neither browsed nor searched', async () => {
  store.clear();
  saveSettings({ disabledSources: ['xifan', 'hema'] });
  for (const source of ['xifan', 'hema']) {
    const list = await browseList({ source });
    assert.equal(list.success, false);
    assert.match(list.error, /此来源已关闭/);
    const found = await search('剧名', { source });
    assert.equal(found.success, false);
    assert.match(found.error, /此来源已关闭/);
  }
  const sequel = await findNextSeasons({ series_id: 'hema:1', series_title: '剧名第一季' });
  assert.equal(sequel.success, false);
  assert.match(sequel.error, /此来源已关闭/);
});

test('searching every source leaves out the ones turned off', async () => {
  const { setTransport } = await import('../src/lib/http.js');
  store.clear();
  saveSettings({ disabledSources: ['hema'] });
  setTransport(async () => { throw new Error('offline'); });
  try {
    const found = await search('剧名', { source: 'all' });
    assert.deepEqual(found.errors.map(e => e.source).sort(), ['hongguo', 'xifan']);
  } finally { setTransport(null); }
});
