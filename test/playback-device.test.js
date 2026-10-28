// Offline: the anonymous device registration body and its pure JS building blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { aes128CbcEncrypt } from '../src/lib/crypto.js';
import { gzipStored, crc32, randomUuid } from '../src/lib/bytes.js';
import { registrationBody, getPlaybackDevice, resetPlaybackDevice } from '../src/sources/playback-device.js';

const SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');

test('aes128CbcEncrypt matches node (PKCS#7)', () => {
  for (const n of [0, 1, 15, 16, 17, 100]) {
    const key = crypto.randomBytes(16); const iv = crypto.randomBytes(16); const data = crypto.randomBytes(n);
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    assert.equal(Buffer.from(aes128CbcEncrypt(key, iv, data)).toString('hex'), Buffer.concat([c.update(data), c.final()]).toString('hex'), 'length ' + n);
  }
});

test('gzipStored is valid gzip', () => {
  for (const n of [0, 1, 1000, 65535, 65536, 200000]) {
    const data = crypto.randomBytes(n);
    assert.ok(zlib.gunzipSync(Buffer.from(gzipStored(data))).equals(data), 'length ' + n);
  }
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('randomUuid is a version 4 UUID', () => {
  assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the registration body decrypts to the gzipped anonymous phone profile', () => {
  const body = Buffer.from(registrationBody(1700000000000, 'cdid-x'));
  assert.equal(body.subarray(0, 6).toString('hex'), '746305100000');
  const random = body.subarray(6, 38);
  const derived = crypto.createHash('sha512').update(Buffer.concat([crypto.createHash('sha512').update(random).digest(), SALT])).digest();
  const d = crypto.createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const plain = Buffer.concat([d.update(body.subarray(38)), d.final()]);
  const gz = plain.subarray(64);
  assert.ok(crypto.createHash('sha512').update(gz).digest().equals(plain.subarray(0, 64)));
  const log = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  assert.equal(log.magic_tag, 'ss_app_log');
  assert.equal(log._gen_time, 1700000000000);
  assert.equal(log.header.cdid, 'cdid-x');
  assert.equal(log.header.aid, 8662);
  assert.equal(log.header.display_name, '红果免费短剧');
});

test('concurrent callers share one registration; a failure is retried only after a pause', async () => {
  resetPlaybackDevice();
  let calls = 0;
  let answer = { device_id_str: '7000000000000000001', install_id_str: '7000000000000000002' };
  const requestJson = async (url, options) => {
    calls++;
    assert.match(url, /^https:\/\/log5-applog-lf\.fqnovel\.com\/service\/2\/device_register\//);
    assert.equal(options.headers['x-ss-stub'], crypto.createHash('md5').update(options.body).digest('hex').toUpperCase());
    return answer;
  };
  const [a, b] = await Promise.all([getPlaybackDevice(requestJson), getPlaybackDevice(requestJson)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual({ device_id: a.device_id, iid: a.iid }, { device_id: '7000000000000000001', iid: '7000000000000000002' });

  resetPlaybackDevice();
  calls = 0;
  // An ID that no longer fits a double has lost digits and must not be used.
  answer = { device_id: 7000000000000000001, install_id: 7000000000000000002 };
  await assert.rejects(getPlaybackDevice(requestJson), err => err.code === 'DEVICE_REGISTRATION_FAILED');
  await assert.rejects(getPlaybackDevice(requestJson), err => err.code === 'DEVICE_REGISTRATION_FAILED');
  assert.equal(calls, 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 31000;
  try {
    answer = { device_id: 123, install_id_str: '456' };
    const d = await getPlaybackDevice(requestJson);
    assert.equal(calls, 2);
    assert.deepEqual([d.device_id, d.iid], ['123', '456']);
  } finally {
    Date.now = realNow;
    resetPlaybackDevice();
  }
});
