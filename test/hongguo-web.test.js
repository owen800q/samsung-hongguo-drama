import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWebMedia } from '../src/sources/hongguo.js';

const SID = '7686713195246930968';
const VID = '7686715221565508670';
const PLAYER = 'https://hongguoduanju.com/player/' + SID + '/' + VID;

function page({ model = {}, videos = [] } = {}) {
  const data = {
    isSuccess: true, series_id: SID, vid: VID, seriesDetail: { series_id: SID },
    publicVideoSeo: { available: true, seriesId: SID, itemId: VID }, ...model,
  };
  const router = { loaderData: { 'player_(series_id)/(vid)/page': data } };
  return '<html><head>' + videos.map(v => '<script type="application/ld+json">' + JSON.stringify(v) + '</script>').join('') +
    '</head><body><script>window._ROUTER_DATA = ' + JSON.stringify(router) + ';</script></body></html>';
}
const video = (url, contentUrl, extra = {}) => ({ '@type': 'VideoObject', '@id': url + '#video', url, contentUrl, ...extra });

test('web media comes from the VideoObject bound to this player', () => {
  const other = video('https://hongguoduanju.com/player/1/2', 'https://hongguoduanju.com/video/public/2/360p.mp4');
  const own = video(PLAYER, 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4?a=1&Range=0-');
  assert.equal(pickWebMedia(page({ videos: [other, own] }), VID, SID), 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4?a=1');
  assert.equal(pickWebMedia(page({ videos: [other] }), VID, SID), '');
  // A first episode's page uses the series URL as its canonical address.
  const first = video('https://hongguoduanju.com/player/' + SID, 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4');
  assert.equal(pickWebMedia(page({ videos: [first] }), VID, SID), 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4');
  // ...but only with the site's own media path for this episode.
  const firstOther = video('https://hongguoduanju.com/player/' + SID, 'https://hongguoduanju.com/video/public/2/360p.mp4');
  assert.equal(pickWebMedia(page({ videos: [firstOther] }), VID, SID), '');
  const firstCdn = video('https://hongguoduanju.com/player/' + SID, 'https://cdn.example.com/video/public/' + VID + '/360p.mp4');
  assert.equal(pickWebMedia(page({ videos: [firstCdn] }), VID, SID), '');
  assert.equal(pickWebMedia(page({ videos: [firstOther, first] }), VID, SID), 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4');
  assert.equal(pickWebMedia(page({ videos: [own] }), VID, ''), 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4?a=1');
});

test('web media is rejected when the page is not this public episode', () => {
  const own = video(PLAYER, 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4');
  assert.equal(pickWebMedia(page({ videos: [own], model: { vid: '1' } }), VID, SID), '');
  assert.equal(pickWebMedia(page({ videos: [own] }), VID, '123'), '');
  assert.equal(pickWebMedia(page({ videos: [own], model: { isSuccess: false } }), VID, SID), '');
  assert.equal(pickWebMedia(page({ videos: [own], model: { publicVideoSeo: { available: false, seriesId: SID, itemId: VID } } }), VID, SID), '');
  // A protected page's public file is only a short preview.
  assert.equal(pickWebMedia(page({ videos: [own], model: { protectedPlayback: true } }), VID, SID), '');
  assert.equal(pickWebMedia(page({ videos: [own], model: { protectedPlayback: false } }), VID, SID), 'https://hongguoduanju.com/video/public/' + VID + '/360p.mp4');
  assert.equal(pickWebMedia(page({ videos: [video(PLAYER, 'javascript:alert(1)')] }), VID, SID), '');
  assert.equal(pickWebMedia(page({ videos: [video(PLAYER, 'https://u:p@cdn.example.com/a.mp4')] }), VID, SID), '');
  assert.equal(pickWebMedia('<html>no data</html>', VID, SID), '');
});
