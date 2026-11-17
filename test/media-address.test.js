// Upstream 7.3: cover and video addresses from a source must point at the public internet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicMediaUrl, httpsUrl } from '../src/sources/util.js';

test('addresses on this TV or the home network are not accepted as media', () => {
  for (const url of ['https://v3-novelapp.fqnovelvod.com/a/b.mp4?x=1', 'http://cdn.example.com/a.mp4', 'https://8.8.8.8/a.mp4',
    'https://172.32.0.1/a', 'https://100.128.0.1/a', 'https://192.0.1.1/a', 'https://[2400:3200::1]/a.mp4', 'https://example.com./a']) {
    assert.equal(isPublicMediaUrl(url), true, url);
  }
  for (const url of ['https://127.0.0.1/a.mp4', 'https://10.1.2.3/a', 'https://192.168.1.1/a', 'https://172.16.0.1/a', 'https://172.31.255.255/a',
    'https://169.254.1.1/a', 'https://100.64.0.1/a', 'https://198.18.0.1/a', 'https://198.19.255.1/a', 'https://192.0.2.1/a', 'https://192.0.0.1/a',
    'https://198.51.100.7/a', 'https://203.0.113.7/a', 'https://224.0.0.1/a', 'https://255.255.255.255/a', 'https://0.0.0.0/a',
    'https://2130706433/a', 'https://0x7f000001/a', 'https://127.1/a',
    'https://[::1]/a', 'https://[fe80::1]/a', 'https://[fd00::1]/a', 'https://[2001:db8::1]/a', 'https://[2002:c0a8:101::1]/a', 'https://[2001:0:1::1]/a',
    'https://[::ffff:192.168.1.1]/a',
    'https://localhost/a', 'https://tv.local/a', 'https://nas.lan/a', 'https://router.home/a', 'https://svc.internal/a', 'https://intranet/a',
    'https://user:pass@example.com/a', 'ftp://example.com/a', 'file:///etc/passwd', 'not a url', '']) {
    assert.equal(isPublicMediaUrl(url), false, url);
  }
  assert.equal(httpsUrl('https://192.168.1.1/cover.jpg'), '');
  assert.equal(httpsUrl('http://cdn.example.com/cover.jpg'), '', 'covers and Xifan / Hema videos stay https only');
  assert.equal(httpsUrl('https://cdn.example.com/cover.jpg'), 'https://cdn.example.com/cover.jpg');
});
