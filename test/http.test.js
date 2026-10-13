import test from 'node:test';
import assert from 'node:assert/strict';
import { memo } from '../src/lib/http.js';

test('memo shares in-flight requests and caches results', async () => {
  const cached = memo(60000);
  let calls = 0;
  const load = () => { calls++; return Promise.resolve(calls); };
  const [a, b] = await Promise.all([cached('k', load), cached('k', load)]);
  assert.equal(a, 1); assert.equal(b, 1);
  assert.equal(await cached('k', load), 1);
  assert.equal(calls, 1);
});

test('forced memo request bypasses cache and in-flight work, and owns the key', async () => {
  const cached = memo(60000);
  let releaseOld;
  const old = cached('k', () => new Promise(r => { releaseOld = r; }));
  const forced = await cached('k', () => Promise.resolve('fresh'), true);
  assert.equal(forced, 'fresh');
  releaseOld('stale');
  assert.equal(await old, 'stale');
  // The older request finished last but must not replace the forced result.
  assert.equal(await cached('k', () => Promise.resolve('unused')), 'fresh');
});
