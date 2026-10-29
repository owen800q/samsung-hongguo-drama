import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { md5, sha512, sm3, Aes128, aes128CbcDecrypt, aes128CbcEncrypt, cencCtrInPlace } from '../src/lib/crypto.js';
import { toBase64, fromBase64, fromHex, toHex, add64, rotr64, u64, gzipStored, crc32 } from '../src/lib/bytes.js';
import { registrationBody } from '../src/sources/playback-device.js';
import { decryptMp4, clearVideoType } from '../src/media/cenc.js';

const hex = b => Buffer.from(b).toString('hex');
const box = (type, ...children) => {
  const body = Buffer.concat(children.map(c => Buffer.from(c)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};

test('md5 / sha512 match node', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 111, 112, 127, 128, 999]) {
    const d = crypto.randomBytes(n);
    assert.equal(hex(md5(d)), crypto.createHash('md5').update(d).digest('hex'));
    assert.equal(hex(sha512(d)), crypto.createHash('sha512').update(d).digest('hex'));
  }
});

test('sm3 standard vector', () => {
  assert.equal(hex(sm3('abc')), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');
});

test('aes ecb/cbc/ctr match node', () => {
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(16), data = crypto.randomBytes(160);
  const e = crypto.createCipheriv('aes-128-ecb', key, null); e.setAutoPadding(false);
  const ecb = Buffer.concat([e.update(data), e.final()]);
  const aes = new Aes128(key);
  assert.equal(hex(aes.encryptBlock(data.subarray(0, 16))), hex(ecb.subarray(0, 16)));
  assert.equal(hex(aes.decryptBlock(ecb.subarray(0, 16))), hex(data.subarray(0, 16)));
  const c = crypto.createCipheriv('aes-128-cbc', key, iv); c.setAutoPadding(false);
  assert.equal(hex(aes128CbcDecrypt(key, iv, Buffer.concat([c.update(data), c.final()]))), hex(data));
  const nonce = crypto.randomBytes(8);
  const ctr = crypto.createCipheriv('aes-128-ctr', key, Buffer.concat([nonce, Buffer.alloc(8)]));
  const expected = ctr.update(data.subarray(0, 150));
  const buf = new Uint8Array(data.subarray(0, 150));
  cencCtrInPlace(aes, nonce, buf, 0, 150);
  assert.equal(hex(buf), hex(expected));
});

test('base64 and 64-bit helpers', () => {
  const d = crypto.randomBytes(37);
  assert.equal(toBase64(d), d.toString('base64'));
  assert.equal(toBase64(d, true), d.toString('base64url'));
  assert.equal(hex(fromBase64(d.toString('base64url'))), hex(d));
  const a = 0xfedcba9876543210n, b = 0x0123456789abcdefn;
  const A = u64(0xfedcba98, 0x76543210), B = u64(0x01234567, 0x89abcdef);
  const s = add64(A, B);
  assert.equal((BigInt(s.hi) << 32n) | BigInt(s.lo), (a + b) & 0xffffffffffffffffn);
  for (const n of [1, 8, 31, 32, 33, 61]) {
    const r = rotr64(A, n);
    assert.equal((BigInt(r.hi) << 32n) | BigInt(r.lo), ((a >> BigInt(n)) | (a << BigInt(64 - n))) & 0xffffffffffffffffn);
  }
  assert.equal(toHex(fromHex('00ff10')), '00ff10');
});

// An encrypted App-source episode (key below); point CENC_SAMPLE at one to run this test.
const SAMPLE = process.env.CENC_SAMPLE || '/private/tmp/claude-501/t/enc.mp4';
test('cenc decrypt of real App episode decodes cleanly', { skip: !fs.existsSync(SAMPLE) && 'sample missing' }, async () => {
  const out = await decryptMp4(new Uint8Array(fs.readFileSync(SAMPLE)), fromHex('71aa250f3253f041d14edbdce6ecebeb'));
  const dir = process.env.SCRATCH || '/private/tmp/claude-501/t';
  const file = dir + '/out-test.mp4';
  fs.writeFileSync(file, out);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_tag_string', '-of', 'csv=p=0', file]).toString();
  assert.match(probe, /hevc,hvc1/);
  assert.match(probe, /aac,mp4a/);
  const errs = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-t', '5', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  assert.equal(errs.trim(), '');
});

test('an encrypted video entry keeps its real codec', () => {
  const type = (...boxes) => { const d = new Uint8Array(Buffer.concat(boxes)); return clearVideoType(d, 0, d.length); };
  const sinf = original => box('sinf', box('frma', original), box('schm', Buffer.alloc(8)));
  assert.equal(type(box('avcC', Buffer.alloc(4)), sinf('avc1')), 'avc1');
  assert.equal(type(box('hvcC', Buffer.alloc(4)), sinf('hvc1')), 'hvc1');
  // Without frma the config box decides, so H.264 is not labelled HEVC.
  assert.equal(type(box('avcC', Buffer.alloc(4))), 'avc1');
  assert.equal(type(box('hvcC', Buffer.alloc(4))), 'hvc1');
  assert.throws(() => type(box('hvcC', Buffer.alloc(4)), sinf('avc1')), /原始编码/);
  assert.throws(() => type(box('avcC', Buffer.alloc(4)), box('hvcC', Buffer.alloc(4))), /原始编码/);
  assert.throws(() => type(sinf('vp09')), /原始编码/);
});

test('aes cbc encrypt matches node, with PKCS#7 padding', () => {
  for (const n of [0, 1, 15, 16, 17, 160]) {
    const key = crypto.randomBytes(16), iv = crypto.randomBytes(16), data = crypto.randomBytes(n);
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    assert.equal(hex(aes128CbcEncrypt(key, iv, data)), hex(Buffer.concat([c.update(data), c.final()])));
  }
});

test('stored gzip unpacks with zlib, across block boundaries', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const n of [0, 1, 1000, 65535, 65536, 140000]) {
    const data = crypto.randomBytes(n);
    assert.equal(hex(zlib.gunzipSync(gzipStored(data))), hex(data));
  }
});

test('device registration body decrypts to the gzipped app log', () => {
  const body = registrationBody({ aid: 8662 }, 1700000000000);
  assert.equal(hex(body.subarray(0, 6)), '746305100000');
  const salt = fromHex('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58');
  const derived = crypto.createHash('sha512').update(Buffer.concat([crypto.createHash('sha512').update(body.subarray(6, 38)).digest(), salt])).digest();
  const d = crypto.createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const plain = Buffer.concat([d.update(body.subarray(38)), d.final()]);
  const gz = plain.subarray(64);
  assert.equal(hex(plain.subarray(0, 64)), crypto.createHash('sha512').update(gz).digest('hex'));
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz)), { magic_tag: 'ss_app_log', header: { aid: 8662 }, _gen_time: 1700000000000 });
});
