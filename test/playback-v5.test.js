// Playback v5 signing (upstream 7.5). The two fixture files are the public synthetic vectors
// of N3urda/hongguoTV 18c37c2afd0567520135abcae312352542f09083 (GPL-3.0), as shipped with
// the desktop app: no identity, session or media address in them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { signPlaybackV5, hashF13, CarrierV5, medusaMessage, setV5Entropy } from '../src/sources/playback-v5.js';
import { sm3 } from '../src/lib/crypto.js';
import { utf8, fromHex, toHex, gzipStored } from '../src/lib/bytes.js';

const fixture = name => JSON.parse(fs.readFileSync(new URL('./fixtures/' + name, import.meta.url)));
const NOW = 1800000000000;
const BASE = 'https://example.test/model';
const VALUES = Object.freeze({ aid: '8662', app_name: 'novelread',
  device_id: '1234567890123456789', iid: '2234567890123456789', cdid: 'synthetic-device',
  version_name: '7.4.3.32', channel: 'vivo_8662_64', os_version: '12', device_type: 'PGT-AN10',
  _rticket: '1', text: '中文 !*\'()~ +&=%', empty: '' });
const BODY = new Uint8Array(gzipSync(Buffer.from('{"mixed_video_id_map":{"1004":["123"]},"dr_scene":"player"}')));
const md5 = bytes => crypto.createHash('md5').update(bytes).digest();

function ivFold(initial, bytes) {
  let value = initial;
  for (const [i, byte] of bytes.entries()) value = i % 2 === 0
    ? ((value >>> 4) ^ value ^ (value << 6) ^ byte) >>> 0
    : ~((value >>> 7) ^ value ^ (byte | (value << 12))) >>> 0;
  return value;
}
function branch(query, body, ts) {
  const time = Buffer.alloc(4); time.writeUInt32LE(ts);
  return ivFold(ivFold(ivFold(0x20230928, sm3(utf8(query))), md5(body)), time) & 15;
}
// Independent wire reader for the serialized message.
function fields(bytes) {
  let offset = 0;
  const result = new Map();
  function uint() {
    let value = 0n, shift = 0n;
    while (offset < bytes.length && shift < 70n) {
      const next = bytes[offset++];
      value |= BigInt(next & 127) << shift;
      if (!(next & 128)) return value;
      shift += 7n;
    }
    throw Error('Invalid synthetic protobuf');
  }
  while (offset < bytes.length) {
    const tag = Number(uint()), type = tag & 7;
    let value;
    if (type === 0) value = uint();
    else {
      assert.equal(type, 2);
      const length = Number(uint());
      assert.ok(offset + length <= bytes.length);
      value = Buffer.from(bytes.subarray(offset, offset + length));
      offset += length;
    }
    assert.ok(!result.has(tag >>> 3));
    result.set(tag >>> 3, value);
  }
  return result;
}
const text = (message, tag) => message.get(tag) && message.get(tag).toString();
const sint = (message, tag) => Number(message.get(tag) >> 1n);
const fixed = byte => n => new Uint8Array(n).fill(byte);

test('v5: f13 digests match the published vectors for all 32 timestamp rotation classes', () => {
  const rows = fixture('signing-v5-f13.json');
  assert.equal(rows.length, 32);
  assert.equal(new Set(rows.map(row => row.ts & 31)).size, 32);
  rows.forEach((row, index) => {
    const actual = hashF13(fromHex(row.query), fromHex(row.body), row.ts);
    assert.equal(toHex(actual.subarray(0, 16)), row.digest, 'f13 timestamp class ' + index);
    assert.equal(actual.length, 20);
    assert.equal(actual[16] & 0x24, 0x24);
  });
  // Any other branch is refused rather than signed with the wrong rounds.
  const wrong = fromHex(rows[0].query);
  const time = Buffer.alloc(4); time.writeUInt32LE(rows[0].ts);
  let rejected = false;
  for (let i = 0; i < 256 && !rejected; i++) {
    wrong[0] = i;
    if ((ivFold(ivFold(ivFold(0x20230928, wrong), fromHex(rows[0].body)), time) & 15) === 12) continue;
    assert.throws(() => hashF13(wrong, fromHex(rows[0].body), rows[0].ts), /Unsupported v5 hash branch/);
    rejected = true;
  }
  assert.ok(rejected);
});

test('v5: carrier output matches the published vectors for all four permutations', () => {
  const rows = fixture('signing-v5-carrier.json');
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.ts & 3)).size, 4);
  rows.forEach((row, index) => {
    const source = fromHex(row.source);
    const actual = new CarrierV5(fromHex(row.key), row.ts).encrypt(source, fromHex(row.iv));
    assert.equal(toHex(actual), row.encrypted, 'carrier permutation ' + index);
    assert.equal(toHex(source), row.source);
  });
});

test('v5: the first ticket on the signed branch is chosen, and query, body and second are bound', t => {
  setV5Entropy(fixed(0x80), NOW);
  t.after(() => setV5Entropy());
  for (let i = 0; i < 32; i++) {
    const now = NOW + i * 1000 + 999, ts = Math.floor(now / 1000);
    const signed = signPlaybackV5({ base: BASE, values: VALUES, body: BODY, now });
    const url = new URL(signed.url), query = signed.url.split('?')[1];
    const ticket = Number(url.searchParams.get('_rticket'));
    assert.ok(ticket >= now && ticket <= now + 1023);
    for (let previous = now; previous < ticket; previous++) {
      assert.notEqual(branch(query.replace(/_rticket=\d+/, '_rticket=' + previous), BODY, ts), 12, 'must choose the first matching ticket');
    }
    assert.equal(branch(query, BODY, ts), 12);
    for (const [key, value] of Object.entries(VALUES)) if (key !== '_rticket') assert.equal(url.searchParams.get(key), value);
    // Field order is kept, _rticket included.
    assert.deepEqual(Array.from(url.searchParams.keys()), Object.keys(VALUES));
    assert.ok(query.includes('text=%E4%B8%AD%E6%96%87%20%21*%27%28%29~%20%2B%26%3D%25'));
    assert.equal(url.searchParams.get('ts'), null);
    assert.equal(signed.headers['x-khronos'], String(ts));
    assert.equal(signed.headers['x-ss-stub'], md5(BODY).toString('hex').toUpperCase());
    const prefix = Buffer.from(signed.headers['x-medusa'], 'base64').subarray(0, 20);
    const time = Buffer.alloc(4); time.writeUInt32LE(ts);
    for (let at = 0; at < prefix.length; at++) prefix[at] ^= time[at & 3];
    assert.equal(prefix.readUInt32LE(), 5);
    assert.equal(prefix.subarray(4).toString('hex'), '2d4b4fca49750d433fb5ae2c226dcc56');
    assert.deepEqual(Object.keys(signed.headers).sort(), ['x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
  }
  assert.equal(new URL(signPlaybackV5({ base: BASE, values: Object.assign({}, VALUES, { ts: '1' }), body: BODY, now: NOW + 999 }).url).searchParams.get('ts'), String(NOW / 1000));
});

test('v5: the registered identity and profile are in the serialized Medusa message', t => {
  setV5Entropy(fixed(0x80), NOW);
  t.after(() => setV5Entropy());
  const ts = NOW / 1000;
  const query = sm3(utf8('a=b'));
  const f13 = new Uint8Array(20).fill(7);
  for (const identity of [VALUES, Object.assign({}, VALUES, { device_id: '3234567890123456789', version_name: '7.5.1.32',
    device_type: 'synthetic-model', os_version: '16', channel: 'synthetic-channel' })]) {
    const message = fields(medusaMessage(query, f13, ts, identity));
    const env = fields(message.get(23)), device = fields(env.get(12));
    assert.equal(text(message, 5), identity.device_id); assert.equal(text(device, 4), identity.device_id);
    assert.equal(text(message, 7), identity.version_name); assert.equal(text(env, 14), identity.version_name);
    assert.equal(text(env, 8), identity.channel); assert.equal(text(device, 22), identity.os_version);
    assert.equal(text(device, 30), identity.device_type); assert.equal(text(device, 32), identity.device_type);
    assert.equal(text(message, 6), '646637794'); assert.equal(sint(message, 2), 5);
    assert.equal(sint(message, 9), 0x040a0300); assert.equal(sint(message, 21), 377);
    assert.equal(sint(message, 12), ts); assert.equal(sint(message, 17), ts);
    assert.equal(message.get(10).toString('hex'), '0000000000000000');
    assert.equal(message.get(13).toString('hex'), toHex(f13));
    assert.equal(message.get(14).toString('hex'), toHex(query.subarray(0, 6)));
    assert.equal(sint(message, 3), 0x80808080, 'a random u32 must not become signed');
    assert.equal(sint(device, 25), NOW, 'a millisecond time must survive without BigInt');
    assert.equal(text(device, 5), Buffer.alloc(18, 0x80).toString('base64url'));
  }
});

test('v5: body, query, iid and cdid each change the signature with randomness held fixed', t => {
  setV5Entropy(fixed(0x80), NOW);
  t.after(() => setV5Entropy());
  const sign = input => signPlaybackV5(Object.assign({ base: BASE, values: VALUES, body: BODY, now: NOW }, input)).headers;
  const first = sign({});
  assert.deepEqual(sign({}), first);
  const sameJsonOtherBytes = gzipStored(utf8('{"mixed_video_id_map":{"1004":["123"]},"dr_scene":"player"}'));
  for (const input of [
    { body: new Uint8Array(gzipSync(Buffer.from('{"mixed_video_id_map":{"1004":["124"]}}'))) },
    { body: sameJsonOtherBytes },
    { values: Object.assign({}, VALUES, { extra: 'one' }) },
    { values: Object.assign({}, VALUES, { iid: '5234567890123456789' }) },
    { values: Object.assign({}, VALUES, { cdid: 'synthetic-another' }) },
  ]) {
    const next = sign(input);
    assert.notEqual(next['x-medusa'], first['x-medusa']);
    assert.equal(next['x-helios'], first['x-helios']);
  }
  assert.notEqual(sign({ now: NOW + 1000 })['x-helios'], first['x-helios']);
});

test('v5: Helios decrypts independently to the timestamp, v5 licence and aid', t => {
  setV5Entropy(fixed(0x5a), NOW);
  t.after(() => setV5Entropy());
  const signed = signPlaybackV5({ base: BASE, values: VALUES, body: BODY, now: NOW + 999 });
  const encrypted = Buffer.from(signed.headers['x-helios'], 'base64');
  const ascii = Buffer.from(md5(Buffer.concat([encrypted.subarray(0, 4), Buffer.from('8662')])).toString('hex'));
  const mask = (1n << 64n) - 1n;
  const rotate = (value, n) => ((value << BigInt(n)) | (value >> BigInt(64 - n))) & mask;
  const keys = [ascii.readBigUInt64LE(0)];
  const queue = [ascii.readBigUInt64LE(8), ascii.readBigUInt64LE(16), ascii.readBigUInt64LE(24)];
  for (let i = 0; i < 33; i++) {
    const l = (((rotate(queue.shift(), 56) + keys[i]) & mask) ^ BigInt(i));
    queue.push(l); keys.push(rotate(keys[i], 3) ^ l);
  }
  const plain = Buffer.alloc(encrypted.length - 4);
  for (let at = 4; at < encrypted.length; at += 16) {
    let a = encrypted.readBigUInt64LE(at), b = encrypted.readBigUInt64LE(at + 8);
    for (let round = 33; round >= 0; round--) {
      const oldA = rotate(a ^ b, 61);
      b = rotate(((b ^ keys[round]) - oldA) & mask, 8); a = oldA;
    }
    plain.writeBigUInt64LE(a, at - 4); plain.writeBigUInt64LE(b, at + 4);
  }
  const padding = plain.at(-1);
  assert.ok(padding > 0 && padding <= 16);
  assert.equal(plain.subarray(0, -padding).toString(), '1800000000-646637794-8662');
});

test('v5: an identity that is not a registered device, or a body that is not gzip, is refused', () => {
  const valid = { base: BASE, values: VALUES, body: BODY, now: NOW };
  for (const values of [Object.assign({}, VALUES, { iid: 123 }), Object.assign({}, VALUES, { device_id: '0' }),
    Object.assign({}, VALUES, { device_id: '1.2' }), Object.assign({}, VALUES, { cdid: '' }), Object.assign({}, VALUES, { version_name: '' })]) {
    assert.throws(() => signPlaybackV5(Object.assign({}, valid, { values })), TypeError);
  }
  for (const body of [undefined, '', new Uint8Array(0), utf8('{}')]) {
    assert.throws(() => signPlaybackV5(Object.assign({}, valid, { body })), TypeError);
  }
});

// Upstream 7.7: a GET is signed over the digest of an empty body and carries no x-ss-stub.
test('v5: a request without a body is signed over the empty-body digest', t => {
  setV5Entropy(fixed(0x80), NOW);
  t.after(() => setV5Entropy());
  const now = NOW + 999, ts = Math.floor(now / 1000);
  const signed = signPlaybackV5({ base: BASE, values: VALUES, body: null, now });
  const query = signed.url.split('?')[1];
  assert.deepEqual(Object.keys(signed.headers).sort(), ['x-helios', 'x-khronos', 'x-medusa']);
  assert.equal(branch(query, Buffer.alloc(0), ts), 12);
  const ticket = Number(new URL(signed.url).searchParams.get('_rticket'));
  for (let previous = now; previous < ticket; previous++) {
    assert.notEqual(branch(query.replace(/_rticket=\d+/, '_rticket=' + previous), Buffer.alloc(0), ts), 12);
  }
  assert.notEqual(signed.headers['x-medusa'], signPlaybackV5({ base: BASE, values: VALUES, body: BODY, now }).headers['x-medusa']);
});
