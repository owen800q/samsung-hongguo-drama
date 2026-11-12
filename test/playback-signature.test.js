// SPDX-License-Identifier: GPL-3.0-only
// Offline: the 551 Argus/Ladon playback signature (upstream 6.9/7.0), against the fixed
// vectors the desktop app pins in src/native/playback-signature.test.cjs. Their source:
// N3urda/hongguoTV 7444bb01aec7b0420740103e551c45f1f66101c9,
// kotlin-tv/core/src/test/kotlin/com/hongguotv/core/PlayerSignTest.kt
// (blob 89f48bb174f558988807ee3ceab2a6011cfff229).
import test from 'node:test';
import assert from 'node:assert/strict';
import { signPlayer, Argus, Ladon, ProtoBuf, Simon } from '../src/sources/playback-signature.js';

const hex = bytes => Buffer.from(bytes).toString('hex');
const bytes = (value, encoding) => new Uint8Array(Buffer.from(value, encoding));
// The TV code has no BigInt; the tests convert at the edge.
const word = n => ({ hi: Number(BigInt.asUintN(64, n) >> 32n), lo: Number(BigInt.asUintN(32, n)) });
const big = w => (BigInt(w.hi) << 32n) | BigInt(w.lo);
const RANDOM = bytes('01020304', 'hex');
const GOLDEN = [
  {
    "query": "aid=1967&device_id=dev_aaaaaaaa&iid=111",
    "ts": 1700000000,
    "randField": 659662259,
    "want": "8oHyrVYEy1xDCDlx64ko40qC6JC9VYY/ZkjJzEl50iSFDw8Yfph1hupLxfKrA9GswSEz0Yi4goA7OQ4u+H8ECdOaQDL4GduQ3LULSq9Q4iSEGbS3L6G24GXChtnmPr6n46M2PLlKpXvF7uE0lhH4yD+X69FpdM41gQwx5Y5U3NdwXFaxlqYFszyp7dlUE6BEBWqwDsiAH8Jk9TGKr/jfHt4fVmMc9zRyNRdGeV0x6aP//x7aV+8Po8a/9KK3UNG5KEpmIgzRT6NUttkBP9gRNUh3"
  },
  {
    "query": "aid=1967&device_id=dev_bbbbbbbbbbbbbbbb&iid=222",
    "ts": 1700000001,
    "randField": 1315257197,
    "want": "8oGWgilKQHD4eCdd0VB0vBSbTAkv/3xWE2YWJkxic35CgXkxrUlMTz05HJAak5b5Xx9yxohnoAAcEX//MI9t7XBBtnPwOTaJzkJgBLaYOOotfI7YuqhsEbE5BB363bhKz/Qw/+MI5gH6pgdAXfsRj68u7Qwu3gqCY1NYstqNZFFVrph7dWtXDBYM1aoVEyfkYD2haoaOr9D/gl1zdzAAzbW7we6lr9/zFApbuNsbr2dagdUrQc51QNN0HBOtIkpVBVunDwXM8qR271Ei+Pa4EgKy"
  },
  {
    "query": "aid=1967&device_id=X&iid=333",
    "ts": 1234567890,
    "randField": 554000487,
    "want": "8oEOCRTb0LQf+M+MsliYu4M9kBzAlzXvFgL/Ub198hyoBGxYfNXLAENmH+K/10JQ+Rbhm2zRxNtNv5wVd885xcb6C6F10zp/9jVeGHGz8plz8W3UXHHNrFKjJptjQElGDbyaVLSKt56+HfwO7ENYMfjVv/5PNi1upVciiHqyOPDDAtwi/fZkwBoU1kC7RolMOuedn4lCg/s0CjnNvxFT0QpF/K0yoW3Zpu30tkadIET7WbZ3+7KT3c1yAA6RKWI4mmw="
  },
  {
    "query": "aid=1967&device_id=test_device_id&iid=456&version_name=6.5.1.32",
    "ts": 1700000000,
    "randField": 420072733,
    "want": "8oHu8LnZm0OtJJIaSr1427D+yeH70h5aZTVjoSW7MfFi/hk1LhjTqsEEWYpwcHfK4/2SXuJxTtopRcPeHzVpeFpUD4B4yxEG7REejpCZ1OqeAaLsw/lMebwUjUHrUjnAZCKq0QyimnwdiTiYIsH3GfiK/xlPcFcARqwX7RkI1qnnWUgiJVDEacSm8yhBat6MvDVOa7+U2MgcLu7Q26pFzX8VX5F+ryP76ETs1nRGLmlhHkwyiKb6CETstvGQnJgocgZBNNvlHD2/P+4LWjFMvhNK"
  }
];

test('protobuf: the exact bean bytes, with values reduced to uint32', () => {
  const bean = new ProtoBuf();
  bean.putVarint(1, 1077940818).putVarint(2, 2).putVarint(3, 305419896)
    .putUtf8(4, '1967').putUtf8(5, 'test_device_id').putUtf8(6, '1611921764')
    .putUtf8(7, '').putUtf8(8, '').putVarint(9, 0).putUtf8(10, '').putUtf8(11, '')
    .putVarint(12, 3400000000).putBytes(13, bytes('106e34a2b8c7', 'hex')).putBytes(14, bytes('ac5095fc674e', 'hex'))
    .putProtobuf(15, new ProtoBuf().putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xc792eccc))
    .putUtf8(16, '').putUtf8(20, 'none').putVarint(21, 738)
    .putProtobuf(23, new ProtoBuf().putUtf8(1, 'NX551J').putVarint(2, 8196).putVarint(4, 0x80e0d800))
    .putVarint(25, 2);
  assert.equal(hex(bean.toBuf()), '08d2a4808204100218f8acd191012204313936372a0e746573745f6465766963655f6964320a313631313932313736343a004200480052005a006080c49fd50c6a06106e34a2b8c77206ac5095fc674e7a0c08011001180138ccd9cbbc0c820100a201046e6f6e65a801e205ba01110a064e583535314a1084402080b0838708c80102');
  assert.equal(hex(new ProtoBuf().putVarint(1, -1).putVarint(2, 4294967301).toBuf()), '08ffffffff0f1005');
});

test('Simon: ciphertext and the last four round keys', () => {
  const k = [1111111111111111111n, 2222222222222222222n, 3333333333333333333n, 4444444444444444444n].map(word);
  assert.deepEqual(Simon.encrypt(word(1234567890123456789n), word(9876543210987654321n), k).map(big),
    [6071150433487837324n, 2027321285990159935n]);
  assert.deepEqual(Simon.keyExpansion(k).slice(68).map(big),
    [13679004903447286117n, 6988159389011166349n, 12845848347567849394n, 14469362449063813004n]);
});

test('Ladon: fixed random bytes', () => {
  assert.equal(Ladon.encrypt(1700000000, 1611921764, 1967, RANDOM), 'AQIDBKM7Y7bWnOIUXmTybD6/MpGbuge4sBwUJsyHVivhtMsH');
});

test('Argus: body and query hashes', () => {
  assert.equal(hex(Argus.bodyHash('')), '106e34a2b8c7');
  assert.equal(hex(Argus.queryHash('')), '106e34a2b8c7');
  assert.equal(hex(Argus.queryHash('aid=1967&device_id=123')), '925b8d86b20f');
  assert.equal(hex(Argus.bodyHash('ac3ef48caa08fa3ed5e025da69edc645')), '5048b6e949d0');
});

GOLDEN.forEach((row, index) => test('Argus: exact ciphertext, vector ' + (index + 1), () => {
  const device = new URLSearchParams(row.query).get('device_id');
  assert.equal(Argus.sign(row.query, '', row.ts, '1967', '1611921764', device, '', row.randField), row.want);
  assert.equal(Argus.sign(row.query, '', row.ts, '1967', '1611921764', device, '', row.randField + 4294967296), row.want, 'the nonce is reduced to uint32');
  assert.equal(signPlayer({ query: row.query, body: null, ts: row.ts, randField: row.randField, ladonRandom: RANDOM })['x-argus'], row.want);
}));

test('the signature covers the final query, the time and the bytes sent; iid stays out of it', () => {
  const input = { query: 'aid=1967&device_id=test_device_id&iid=456&version_name=6.5.1.32', ts: 1700000000, randField: 420072733, ladonRandom: RANDOM };
  const empty = signPlayer(input);
  assert.deepEqual(empty, signPlayer(Object.assign({}, input, { body: new Uint8Array(0) })));
  assert.equal(empty['x-argus'], GOLDEN[3].want, 'the install id field stays empty although iid=456 is present');
  assert.equal(empty['x-ladon'], 'AQIDBKM7Y7bWnOIUXmTybD6/MpGbuge4sBwUJsyHVivhtMsH');
  assert.equal(empty['x-khronos'], '1700000000');
  assert.equal(empty['x-ss-req-ticket'], '1700000000000');
  assert.equal(empty['x-ss-stub'], undefined);
  const raw = signPlayer(Object.assign({}, input, { body: bytes('{"x":1}') }));
  assert.equal(raw['x-ss-stub'], 'ac3ef48caa08fa3ed5e025da69edc645');
  assert.notEqual(raw['x-argus'], empty['x-argus']);
  assert.equal(raw['x-ladon'], empty['x-ladon']);
  assert.notEqual(signPlayer(Object.assign({}, input, { body: bytes('{ "x":1}') }))['x-ss-stub'], raw['x-ss-stub']);
  const escaped = signPlayer(Object.assign({}, input, { query: input.query + '&extra=%2A' }))['x-argus'];
  assert.notEqual(escaped, empty['x-argus']);
  assert.notEqual(signPlayer(Object.assign({}, input, { query: input.query + '&extra=*' }))['x-argus'], escaped);
  const later = signPlayer(Object.assign({}, input, { ts: input.ts + 1 }));
  assert.notEqual(later['x-argus'], empty['x-argus']);
  assert.notEqual(later['x-ladon'], empty['x-ladon']);
});

test('without fixed randomness two signatures of the same request differ', () => {
  const input = { query: 'aid=8662&device_id=1&version_name=7.3.9.32', ts: 1700000000 };
  const a = signPlayer(input);
  const b = signPlayer(input);
  assert.notEqual(a['x-argus'], b['x-argus']);
  assert.notEqual(a['x-ladon'], b['x-ladon']);
  assert.throws(() => signPlayer({ query: input.query, ts: 1.5 }), TypeError);
  assert.throws(() => signPlayer({ query: input.query, ts: 1, body: 'text' }), TypeError);
});
