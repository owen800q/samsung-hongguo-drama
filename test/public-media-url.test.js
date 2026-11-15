import test from 'node:test';
import assert from 'node:assert/strict';
import { httpsUrl, isPublicMediaUrl } from '../src/sources/util.js';
import { pickWebMedia } from '../src/sources/hongguo.js';

// Upstream 7.3: media and cover addresses must point at the public internet.
test('public media addresses pass', () => {
  for (const url of [
    'https://hongguoduanju.com/video/public/1/360p.mp4', 'http://v3-novelapp.qznovelvod.com/a.mp4?x=1',
    'https://8.8.8.8/a.mp4', 'https://198.17.255.255/a', 'https://172.32.0.1/a', 'https://100.128.0.1/a',
    'https://[2400:3200::1]/a.mp4', 'https://[::ffff:8.8.8.8]/a', 'https://cdn.example.com./a',
  ]) assert.equal(isPublicMediaUrl(url), true, url);
});

test('loopback, private, reserved and local addresses are refused', () => {
  for (const url of [
    'https://127.0.0.1/a.mp4', 'https://0x7f.1/a.mp4', 'https://2130706433/a.mp4', 'https://0.0.0.0/a',
    'https://10.1.2.3/a', 'https://100.64.0.1/a', 'https://169.254.169.254/latest', 'https://172.16.0.1/a',
    'https://172.31.255.255/a', 'https://192.168.1.1/a', 'https://192.0.2.1/a', 'https://198.18.0.1/a',
    'https://198.19.255.255/a', 'https://198.51.100.1/a', 'https://203.0.113.1/a', 'https://224.0.0.1/a', 'https://255.255.255.255/a',
    'https://[::1]/a', 'https://[::]/a', 'https://[fe80::1]/a', 'https://[fc00::1]/a', 'https://[2001:db8::1]/a',
    'https://[2001::1]/a', 'https://[2002:7f00:1::]/a', 'https://[::ffff:127.0.0.1]/a', 'https://[::ffff:c0a8:101]/a',
    'https://localhost/a', 'https://tv.local/a', 'https://nas.lan/a', 'https://router.home/a', 'https://db.internal/a',
    'https://intranet/a', 'https://LOCALHOST./a', 'ftp://example.com/a', 'file:///tmp/a.mp4',
    'https://user:pw@example.com/a', 'not a url', '',
  ]) assert.equal(isPublicMediaUrl(url), false, url);
});

test('source addresses keep https only and drop non-public hosts', () => {
  assert.equal(httpsUrl('https://cdn.example.com/a.mp4'), 'https://cdn.example.com/a.mp4');
  assert.equal(httpsUrl('http://cdn.example.com/a.mp4'), '');
  assert.equal(httpsUrl('https://192.168.1.10/a.mp4'), '');
  assert.equal(httpsUrl('https://localhost/a.mp4'), '');
});

test('a web page cannot hand over a non-public media address', () => {
  const SID = '7686713195246930968', VID = '7686715221565508670';
  const player = 'https://hongguoduanju.com/player/' + SID + '/' + VID;
  const page = contentUrl => '<html><head><script type="application/ld+json">' +
    JSON.stringify({ '@type': 'VideoObject', '@id': player + '#video', url: player, contentUrl }) + '</script></head><body><script>window._ROUTER_DATA = ' +
    JSON.stringify({ loaderData: { 'player_(series_id)/(vid)/page': { isSuccess: true, series_id: SID, vid: VID, seriesDetail: { series_id: SID }, publicVideoSeo: { available: true, seriesId: SID, itemId: VID } } } }) +
    ';</script></body></html>';
  assert.equal(pickWebMedia(page('https://cdn.example.com/' + VID + '/360p.mp4'), VID, SID), 'https://cdn.example.com/' + VID + '/360p.mp4');
  assert.equal(pickWebMedia(page('http://192.168.1.10/' + VID + '/360p.mp4'), VID, SID), '');
  assert.equal(pickWebMedia(page('https://127.0.0.1/' + VID + '/360p.mp4'), VID, SID), '');
});
