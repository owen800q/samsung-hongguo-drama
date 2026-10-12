import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { resolvePlayback, prefetch, release } from '../media/playback.js';
import { CancelToken } from '../lib/http.js';
import { getHistoryEntry, getSettings, recordProgress, saveSettings } from '../lib/storage.js';
import { errorMessage, formatTime } from '../lib/format.js';
import { setScreenSaver } from '../platform/tv.js';
import { Icon } from '../components/Icon.jsx';
import { focusElement, focusFirst } from '../lib/focus.js';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const OSD_TIMEOUT = 5000;
const SEEK_COMMIT_MS = 650;

function phaseLabel(p) {
  if (!p) return '正在准备…';
  if (p.phase === 'fetch') return '正在获取播放地址…';
  if (p.phase === 'download') return p.total ? '正在缓冲片源 ' + Math.floor(p.loaded / p.total * 100) + '%' : '正在缓冲片源…';
  if (p.phase === 'decrypt' || p.phase === 'store') return '正在处理片源…';
  if (p.phase === 'buffer') return '正在缓冲…';
  return '正在准备…';
}

export function Player({ series, index: startIndex, fromStart }) {
  const router = useRouter();
  const video = useRef(null);
  const settings = useRef(getSettings());
  const [index, setIndex] = useState(startIndex || 0);
  const [status, setStatus] = useState('loading'); // loading | playing | paused | ended | error
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [time, setTime] = useState({ current: 0, duration: 0, buffered: 0 });
  const [osd, setOsd] = useState(true);
  const [panel, setPanel] = useState(null); // 'episodes' | 'speed' | null
  const [rate, setRate] = useState(settings.current.playbackRate || 1);
  const [seekTarget, setSeekTarget] = useState(null);
  const [upNext, setUpNext] = useState(false);
  const osdTimer = useRef(0);
  const seekTimer = useRef(0);
  const seekRef = useRef(null);
  const started = useRef(false);
  const saveTimer = useRef(0);
  const resumeFrom = useRef(0);
  const prefetched = useRef('');
  const skipResume = useRef(!!fromStart);

  const episodes = series.episodes;
  const episode = episodes[index];
  const nextIndex = findPlayable(index + 1, 1);
  const prevIndex = findPlayable(index - 1, -1);

  function findPlayable(from, step) {
    for (let i = from; i >= 0 && i < episodes.length; i += step) if (!episodes[i].locked) return i;
    return -1;
  }

  // ---------- OSD visibility ----------
  function showOsd(keep) {
    setOsd(true);
    clearTimeout(osdTimer.current);
    if (!keep) osdTimer.current = setTimeout(() => {
      const v = video.current;
      if (v && !v.paused && !panelRef.current) setOsd(false);
    }, OSD_TIMEOUT);
  }
  const panelRef = useRef(panel);
  panelRef.current = panel;

  // ---------- progress persistence ----------
  // The episode whose media is in the <video> right now (null while switching).
  const loadedEpisode = useRef(null);
  function save() {
    const v = video.current;
    const ep = loadedEpisode.current;
    if (!v || !ep || !(v.currentTime > 0)) return;
    recordProgress(series, ep, v.currentTime, v.duration || 0);
  }

  // ---------- load an episode ----------
  useEffect(() => {
    if (!episode) return undefined;
    const token = new CancelToken();
    const v = video.current;
    let handle = null;
    setStatus('loading');
    setError('');
    setProgress({ phase: 'fetch' });
    setTime({ current: 0, duration: 0, buffered: 0 });
    setUpNext(false);
    setSeekTarget(null);
    seekRef.current = null;
    started.current = false;
    clearTimeout(seekTimer.current);
    showOsd(true);
    const history = getHistoryEntry(series.series_id);
    const saved = history && history.positions ? Number(history.positions[episode.vid]) || 0 : 0;
    resumeFrom.current = skipResume.current ? 0 : saved;
    skipResume.current = false;
    loadedEpisode.current = episode;
    resolvePlayback(episode.vid, series.series_id, {
      cancel: token,
      onProgress: (phase, loaded, total) => { if (!token.cancelled) setProgress({ phase, loaded, total }); },
    }).then(result => {
      if (token.cancelled) return;
      handle = result;
      v.src = result.src;
      v.playbackRate = rate;
      v.load();
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }).catch(e => {
      if (token.cancelled) return;
      setStatus('error');
      setError(errorMessage(e, '这一集暂时无法播放'));
      showOsd(true);
    });
    return () => {
      token.cancel();
      save();
      loadedEpisode.current = null;
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
      if (handle && handle.revoke) handle.revoke();
    };
  }, [index]);

  // ---------- video events ----------
  useEffect(() => {
    const v = video.current;
    const on = (name, fn) => { v.addEventListener(name, fn); return () => v.removeEventListener(name, fn); };
    const offs = [
      on('loadedmetadata', () => {
        const at = resumeFrom.current;
        if (at > 3 && v.duration && at < v.duration - 8) v.currentTime = at;
        v.playbackRate = rateRef.current;
      }),
      on('playing', () => {
        setStatus('playing');
        setProgress(null);
        setScreenSaver(false);
        // Only the first start of an episode flashes the controls; resuming after a seek or buffer does not.
        if (!started.current) { started.current = true; showOsd(); }
      }),
      on('pause', () => { if (!v.ended && v.currentTime > 0) { setStatus('paused'); save(); showOsd(true); } setScreenSaver(true); }),
      on('waiting', () => setProgress({ phase: 'buffer' })),
      on('canplay', () => setProgress(p => (p && p.phase === 'buffer' ? null : p))),
      on('timeupdate', () => {
        const buffered = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        setTime({ current: v.currentTime, duration: v.duration || 0, buffered });
        const d = v.duration || 0;
        // Warm up the next episode once this one is well under way.
        if (d && v.currentTime > d * 0.3 && nextRef.current >= 0) {
          const next = episodes[nextRef.current];
          if (next && prefetched.current !== next.vid) {
            prefetched.current = next.vid;
            prefetch(next.vid, series.series_id);
          }
        }
        if (d && d - v.currentTime < 6 && settings.current.autoNext && nextRef.current >= 0) setUpNext(true);
      }),
      on('ended', () => {
        save();
        setScreenSaver(true);
        if (settings.current.autoNext && nextRef.current >= 0) setIndex(nextRef.current);
        else { setStatus('ended'); showOsd(true); }
      }),
      on('error', () => {
        if (!v.getAttribute('src')) return;
        const code = v.error && v.error.code;
        setStatus('error');
        setError(code === 4 ? '电视无法解码这一集的片源格式' : code === 2 ? '网络中断，片源没有加载完成' : '播放出错了，请重试');
        showOsd(true);
      }),
    ];
    saveTimer.current = setInterval(() => { if (!v.paused) save(); }, 5000);
    const onHide = () => { if (document.hidden) { v.pause(); save(); } };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      offs.forEach(off => off());
      clearInterval(saveTimer.current);
      clearTimeout(osdTimer.current);
      clearTimeout(seekTimer.current);
      document.removeEventListener('visibilitychange', onHide);
      setScreenSaver(true);
      episodes.forEach(ep => release(ep.vid));
    };
  }, []);

  const rateRef = useRef(rate);
  rateRef.current = rate;
  const nextRef = useRef(nextIndex);
  nextRef.current = nextIndex;

  // ---------- actions ----------
  function togglePlay() {
    const v = video.current;
    if (status === 'error' || status === 'loading') return;
    if (status === 'ended') { v.currentTime = 0; }
    if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    else v.pause();
    showOsd();
  }

  function seekBy(delta) {
    const v = video.current;
    if (!v.duration || status === 'loading' || status === 'error') return;
    const base = seekRef.current != null ? seekRef.current : v.currentTime;
    const target = Math.max(0, Math.min(v.duration - 1, base + delta));
    seekRef.current = target;
    setSeekTarget(target);
    // Seeking on the bare video keeps the controls hidden so repeated presses keep seeking.
    if (osd) showOsd();
    clearTimeout(seekTimer.current);
    // Rapid presses accumulate; the video seeks once the user pauses.
    seekTimer.current = setTimeout(() => {
      v.currentTime = target;
      seekRef.current = null;
      setSeekTarget(null);
    }, SEEK_COMMIT_MS);
  }

  function go(i) {
    if (i < 0 || i >= episodes.length || i === index) return;
    if (episodes[i].locked) return;
    save();
    setPanel(null);
    setIndex(i);
  }

  function changeRate(r) {
    setRate(r);
    if (video.current) video.current.playbackRate = r;
    saveSettings({ playbackRate: r });
    setPanel(null);
    showOsd();
  }

  function openPanel(name) {
    setPanel(name);
    setOsd(true);
    clearTimeout(osdTimer.current);
  }

  useEffect(() => {
    if (panel === 'episodes') setTimeout(() => focusFirst('.player-panel .is-current'), 0);
    if (panel === 'speed') setTimeout(() => focusFirst('.player-panel .is-current'), 0);
    if (!panel) setTimeout(() => { if (osd) focusFirst('.player-controls [data-autofocus]'); }, 0);
  }, [panel]);

  useEffect(() => {
    if (status === 'error') setTimeout(() => focusFirst('.player-error [data-autofocus]'), 0);
    else if (osd && !panel) setTimeout(() => {
      const el = document.activeElement;
      if (!el || !el.closest || !el.closest('.player-controls')) focusFirst('.player-controls [data-autofocus]');
    }, 0);
  }, [status, osd]);

  useKeys((action, e) => {
    if (panel) {
      if (action === 'back') { setPanel(null); return true; }
      if (action === 'playpause' || action === 'play' || action === 'pause') { togglePlay(); return true; }
      return false;
    }
    if (status === 'error') {
      if (action === 'back') { router.back(); return true; }
      if (action === 'next') { go(nextIndex); return true; }
      if (action === 'previous') { go(prevIndex); return true; }
      return false;
    }
    switch (action) {
      case 'playpause': togglePlay(); return true;
      case 'play': if (video.current.paused) togglePlay(); return true;
      case 'pause': if (!video.current.paused) togglePlay(); return true;
      case 'stop': save(); router.back(); return true;
      case 'forward': seekBy(settings.current.seekStep * 3); return true;
      case 'rewind': seekBy(-settings.current.seekStep * 3); return true;
      case 'next': go(nextIndex); return true;
      case 'previous': go(prevIndex); return true;
      case 'green': openPanel('episodes'); return true;
      case 'yellow': openPanel('speed'); return true;
      case 'info': showOsd(); return true;
      default: break;
    }
    if (!osd) {
      // Bare video: arrows act directly, any other key wakes the controls.
      if (action === 'left') { seekBy(-settings.current.seekStep); return true; }
      if (action === 'right') { seekBy(settings.current.seekStep); return true; }
      if (action === 'enter') { togglePlay(); return true; }
      if (action === 'down') { openPanel('episodes'); return true; }
      if (action === 'up') { showOsd(); return true; }
      if (action === 'back') { save(); router.back(); return true; }
      return false;
    }
    showOsd();
    const focused = document.activeElement;
    const onBar = focused && focused.classList && focused.classList.contains('player-bar');
    if (onBar && (action === 'left' || action === 'right')) { seekBy(action === 'left' ? -settings.current.seekStep : settings.current.seekStep); return true; }
    if (action === 'back') {
      if (status === 'playing') { setOsd(false); return true; }
      save(); router.back(); return true;
    }
    return false;
  });

  const shownTime = seekTarget != null ? seekTarget : time.current;
  const pct = time.duration ? Math.min(100, shownTime / time.duration * 100) : 0;
  const bufferedPct = time.duration ? Math.min(100, time.buffered / time.duration * 100) : 0;
  const busy = status === 'loading' || (progress && progress.phase === 'buffer');

  return (
    <div class={'player' + (osd || status !== 'playing' ? ' osd-visible' : '')}>
      <video ref={video} class="player-video" preload="auto" playsinline />

      {busy && status !== 'error' && (
        <div class="player-loading">
          <span class="spinner spinner-lg" />
          <span>{phaseLabel(progress)}</span>
        </div>
      )}

      {seekTarget != null && !osd && (
        <div class="player-seek-badge">
          <div>{seekTarget >= time.current ? '▶▶ ' : '◀◀ '}{formatTime(seekTarget)} / {formatTime(time.duration)}</div>
          <div class="player-seek-line"><i style={{ width: pct + '%' }} /></div>
        </div>
      )}

      {status === 'error' && (
        <div class="player-error" data-focus-scope>
          <div class="player-error-title">第 {episode && episode.vid_index} 集暂时无法播放</div>
          <div class="player-error-text">{error}</div>
          <div class="player-error-actions">
            <button type="button" tabIndex={-1} class="btn btn-primary focusable" data-autofocus
              onClick={() => { const i = index; setIndex(-1); setTimeout(() => setIndex(i), 0); }}>重试</button>
            {nextIndex >= 0 && <button type="button" tabIndex={-1} class="btn focusable" onClick={() => go(nextIndex)}>播放下一集</button>}
            <button type="button" tabIndex={-1} class="btn focusable" onClick={() => router.back()}>返回详情</button>
          </div>
        </div>
      )}

      <div class="player-top">
        <div class="player-title">{series.series_title}</div>
        <div class="player-sub">第 {episode ? episode.vid_index : '-'} 集 / 共 {episodes.length} 集{rate !== 1 ? ' · ' + rate + '×' : ''}</div>
      </div>

      {upNext && nextIndex >= 0 && status === 'playing' && (
        <div class="player-upnext">即将播放 第 {episodes[nextIndex].vid_index} 集</div>
      )}

      {status !== 'error' && (
        <div class="player-osd">
          <div class="player-bar-row">
            <span class="player-time">{formatTime(shownTime)}</span>
            <div class="player-bar focusable" tabIndex={-1} role="slider" aria-label="播放进度"
              aria-valuemin={0} aria-valuemax={Math.floor(time.duration)} aria-valuenow={Math.floor(shownTime)}
              data-nav-up="none">
              <i class="player-bar-buffered" style={{ width: bufferedPct + '%' }} />
              <i class="player-bar-fill" style={{ width: pct + '%' }} />
              <i class="player-bar-knob" style={{ left: pct + '%' }} />
            </div>
            <span class="player-time">{formatTime(time.duration)}</span>
          </div>
          <div class="player-controls">
            <button type="button" tabIndex={-1} class="ctrl focusable" disabled={prevIndex < 0} onClick={() => go(prevIndex)} aria-label="上一集"><Icon name="prev" /><span>上一集</span></button>
            <button type="button" tabIndex={-1} class="ctrl ctrl-main focusable" data-autofocus onClick={togglePlay} aria-label={status === 'playing' ? '暂停' : '播放'}>
              <Icon name={status === 'playing' ? 'pause' : 'play'} /><span>{status === 'playing' ? '暂停' : status === 'ended' ? '重播' : '播放'}</span>
            </button>
            <button type="button" tabIndex={-1} class="ctrl focusable" disabled={nextIndex < 0} onClick={() => go(nextIndex)} aria-label="下一集"><Icon name="next" /><span>下一集</span></button>
            <button type="button" tabIndex={-1} class="ctrl focusable" onClick={() => openPanel('episodes')}><Icon name="list" /><span>选集</span></button>
            <button type="button" tabIndex={-1} class="ctrl focusable" onClick={() => openPanel('speed')}><Icon name="speed" /><span>{rate}×</span></button>
          </div>
          <div class="player-hints">
            <span><b>◀ ▶</b> 快退/快进 {settings.current.seekStep} 秒</span>
            <span><b>频道 ▲▼</b> 切换剧集</span>
            <span><b class="key-green" /> 选集</span>
            <span><b class="key-yellow" /> 倍速</span>
          </div>
        </div>
      )}

      {panel === 'episodes' && (
        <div class="player-panel" data-focus-scope>
          <h2 class="player-panel-title">选集 <small>共 {episodes.length} 集</small></h2>
          <div class="player-panel-body" data-scroll="y" data-scroll-pad="80">
            <div class="episode-grid episode-grid-compact">
              {episodes.map((ep, i) => (
                <button key={ep.vid} type="button" tabIndex={-1}
                  class={'episode focusable' + (i === index ? ' is-current is-watching' : '') + (ep.locked ? ' is-locked' : '')}
                  onClick={() => go(i)} aria-label={'第' + ep.vid_index + '集'}>
                  {ep.vid_index}{ep.locked && <Icon name="lock" class="episode-lock" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {panel === 'speed' && (
        <div class="player-panel player-panel-narrow" data-focus-scope>
          <h2 class="player-panel-title">播放速度</h2>
          <div class="speed-list">
            {RATES.map(r => (
              <button key={r} type="button" tabIndex={-1} class={'speed-item focusable' + (r === rate ? ' is-current' : '')} onClick={() => changeRate(r)}>
                {r === 1 ? '1.0× 正常' : r + '×'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
