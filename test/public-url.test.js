import test from 'node:test';
import assert from 'node:assert/strict';
import { httpsUrl, isPublicMediaUrl } from '../src/sources/util.js';
import { pickWebMedia } from '../src/sources/hongguo.js';

// Upstream 7.3 (web-media-guard.js): source-supplied addresses must point at the public internet.
test('public hosts and addresses are accepted', () => {
  for (const url of ['https://cdn.example.com/a.mp4', 'http://v3.fqnovelvod.com/x', 'https://8.8.8.8/a', 'https://172.32.0.1/a',
    'https://100.128.0.1/a', 'https://198.20.0.1/a', 'https://[2400:3200::1]/a', 'https://[::ffff:8.8.8.8]/a', 'https://example.com./a']) {
    assert.equal(isPublicMediaUrl(url), true, url);
  }
});

test('private, reserved and home-network addresses are refused', () => {
  for (const url of ['https://localhost/a', 'https://tv/a', 'https://nas.local/a', 'https://router.lan/a', 'https://box.home/a',
    'https://svc.internal/a', 'https://app.localhost./a', 'https://127.0.0.1/a', 'https://0.0.0.0/a', 'https://10.1.2.3/a',
    'https://100.64.0.1/a', 'https://169.254.169.254/a', 'https://172.16.0.1/a', 'https://172.31.255.255/a', 'https://192.168.1.1/a',
    'https://192.0.0.1/a', 'https://192.0.2.1/a', 'https://198.18.0.1/a', 'https://198.19.255.1/a', 'https://198.51.100.1/a',
    'https://203.0.113.1/a', 'https://224.0.0.1/a', 'https://255.255.255.255/a', 'https://2130706433/a', 'https://0x7f.1/a',
    'https://[::1]/a', 'https://[::]/a', 'https://[fe80::1]/a', 'https://[fc00::1]/a', 'https://[2001:db8::1]/a',
    'https://[2001::1]/a', 'https://[2002:c0a8:101::1]/a', 'https://[::ffff:192.168.1.1]/a', 'https://[::ffff:127.0.0.1]/a',
    'https://user:pw@cdn.example.com/a', 'ftp://cdn.example.com/a', 'file:///etc/passwd', 'not a url', '']) {
    assert.equal(isPublicMediaUrl(url), false, url);
  }
});

test('covers and play addresses drop non-public hosts', () => {
  assert.equal(httpsUrl('https://cdn.example.com/c.jpg'), 'https://cdn.example.com/c.jpg');
  assert.equal(httpsUrl('http://cdn.example.com/c.jpg'), '');
  assert.equal(httpsUrl('https://192.168.1.1/c.jpg'), '');
  assert.equal(httpsUrl('https://router.lan/c.jpg'), '');
});

test('a web page naming a private media address yields no web media', () => {
  const SID = '7686713195246930968', VID = '7686715221565508670';
  const player = 'https://hongguoduanju.com/player/' + SID + '/' + VID;
  const page = contentUrl => {
    const data = { isSuccess: true, series_id: SID, vid: VID, seriesDetail: { series_id: SID }, publicVideoSeo: { available: true, seriesId: SID, itemId: VID } };
    return '<script type="application/ld+json">' + JSON.stringify({ '@type': 'VideoObject', url: player, contentUrl }) + '</script>' +
      '<script>window._ROUTER_DATA = ' + JSON.stringify({ loaderData: { 'player_(series_id)/(vid)/page': data } }) + ';</script>';
  };
  assert.equal(pickWebMedia(page('https://v.example.com/a.mp4'), VID, SID), 'https://v.example.com/a.mp4');
  assert.equal(pickWebMedia(page('http://192.168.1.10/a.mp4'), VID, SID), '');
  assert.equal(pickWebMedia(page('https://127.0.0.1/a.mp4'), VID, SID), '');
});
