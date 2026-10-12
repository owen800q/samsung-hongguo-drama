import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter, useActive } from '../router.js';
import { fetchSeries } from '../sources/index.js';
import { getHistoryEntry, isFavorite, toggleFavorite, updateFavorite, subscribe } from '../lib/storage.js';
import { SOURCE_LABEL, errorMessage } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Empty, Spinner } from '../components/Status.jsx';
import { toast } from '../components/Toast.jsx';
import { focusFirst } from '../lib/focus.js';

const RANGE = 50;

export function Detail({ series: initial }) {
  const router = useRouter();
  const active = useActive();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [fav, setFav] = useState(() => isFavorite(initial.series_id));
  const [history, setHistory] = useState(() => getHistoryEntry(initial.series_id));
  const [range, setRange] = useState(0);
  const [coverBroken, setCoverBroken] = useState(false);
  const loaded = useRef(false);

  function load(force) {
    setError('');
    fetchSeries(initial.series_id, { force }).then(res => {
      setData(res);
      if (isFavorite(res.series_id)) updateFavorite(res.series_id, res.total, true);
      const h = getHistoryEntry(res.series_id);
      if (h && h.vid_index > 0 && !loaded.current) setRange(Math.floor((h.vid_index - 1) / RANGE));
      loaded.current = true;
    }).catch(e => setError(errorMessage(e, '剧集信息加载失败')));
  }

  useEffect(() => { load(false); }, [initial.series_id]);
  useEffect(() => subscribe(kind => {
    if (kind === 'history') setHistory(getHistoryEntry(initial.series_id));
    if (kind === 'favorites') setFav(isFavorite(initial.series_id));
  }), [initial.series_id]);
  // Coming back from the player: the resume button text changes, keep focus on it.
  useEffect(() => { if (active) setHistory(getHistoryEntry(initial.series_id)); }, [active]);

  const view = data || initial;
  const episodes = data ? data.episodes : [];
  const resumeIndex = history ? Math.max(0, episodes.findIndex(ep => String(ep.vid) === String(history.vid))) : 0;
  const resumeEp = episodes[resumeIndex];
  const total = data ? data.total : Number(initial.episode_count) || 0;
  const ranges = [];
  for (let i = 0; i < episodes.length; i += RANGE) ranges.push({ start: i, end: Math.min(episodes.length, i + RANGE) });
  const shown = ranges[range] ? episodes.slice(ranges[range].start, ranges[range].end) : [];

  function play(index, fromStart) {
    if (!data || !episodes[index]) return;
    if (episodes[index].locked) {
      toast('第 ' + episodes[index].vid_index + ' 集在来源平台需要解锁，暂不能播放', 'warn');
      return;
    }
    router.push('player', { series: data, index, fromStart: !!fromStart });
  }

  function onFavorite() {
    const on = toggleFavorite(Object.assign({}, view, { total }));
    setFav(on);
    toast(on ? '已加入我的追剧，更新会在「我的追剧」提醒' : '已取消追剧');
  }

  useEffect(() => {
    if (data && active) setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) focusFirst('.screen.is-active [data-autofocus]'); }, 30);
  }, [data]);

  const webLimit = data && data.source === 'hongguo' && Number.isInteger(data.web_accessible_episodes) && data.web_accessible_episodes < total;

  return (
    <div class="detail" data-scroll="y" data-scroll-pad="120">
      <div class="detail-backdrop" style={view.cover ? { backgroundImage: 'url("' + view.cover + '")' } : null} />
      <div class="detail-hero">
        <div class="detail-cover">
          {view.cover && !coverBroken ? <img src={view.cover} alt="" referrerpolicy="no-referrer" onError={() => setCoverBroken(true)} />
            : <div class="poster-fallback">{(view.series_title || '剧').slice(0, 2)}</div>}
        </div>
        <div class="detail-info">
          <div class="detail-eyebrow">{SOURCE_LABEL[view.source || (data && data.source)] || ''}{total ? ' · 全' + total + '集' : ''}</div>
          <h1 class="detail-title">{view.series_title || '加载中…'}</h1>
          {view.tags && view.tags.length > 0 && <div class="detail-tags">{view.tags.slice(0, 5).map(t => <span key={t} class="tag">{t}</span>)}</div>}
          {(data && data.intro) || initial.intro ? <p class="detail-intro">{(data && data.intro) || initial.intro}</p> : null}
          <div class="detail-actions">
            <button type="button" tabIndex={-1} class="btn btn-primary btn-lg focusable" data-autofocus disabled={!data}
              onClick={() => play(resumeIndex)}>
              <Icon name="play" />
              {history && resumeEp ? '继续播放 第' + resumeEp.vid_index + '集' : '立即播放'}
            </button>
            {history && resumeIndex > 0 && (
              <button type="button" tabIndex={-1} class="btn btn-lg focusable" disabled={!data} onClick={() => play(0, true)}>从第1集看</button>
            )}
            <button type="button" tabIndex={-1} class={'btn btn-lg focusable' + (fav ? ' is-on' : '')} onClick={onFavorite}>
              <Icon name={fav ? 'heartFill' : 'heart'} />{fav ? '已追剧' : '追剧'}
            </button>
          </div>
          {webLimit && <p class="detail-note">官网公开前 {data.web_accessible_episodes} 集；其余分集将尝试备用片源，首次打开需要稍候。</p>}
        </div>
      </div>

      <section class="episodes">
        <h2 class="section-title">选集</h2>
        {error && !data && <Empty title="剧集信息加载失败" message={error} onAction={() => load(true)} autofocus />}
        {!data && !error && <Spinner label="正在获取分集…" />}
        {ranges.length > 1 && (
          <div class="tab-row tab-row-sm" data-scroll="x" data-scroll-pad="120">
            <div class="tab-row-track" data-focus-group="detail-ranges">
              {ranges.map((r, i) => (
                <button key={i} type="button" tabIndex={-1} class={'chip focusable' + (i === range ? ' is-selected' : '')}
                  onClick={() => setRange(i)}>{episodes[r.start].vid_index}-{episodes[r.end - 1].vid_index}</button>
              ))}
            </div>
          </div>
        )}
        <div class="episode-grid" data-focus-group="detail-episodes">
          {shown.map(ep => {
            const index = episodes.indexOf(ep);
            const watching = history && String(history.vid) === String(ep.vid);
            return (
              <button key={ep.vid} type="button" tabIndex={-1}
                class={'episode focusable' + (watching ? ' is-watching' : '') + (ep.locked ? ' is-locked' : '')}
                onClick={() => play(index)} aria-label={'第' + ep.vid_index + '集' + (ep.locked ? '，需解锁' : '')}>
                {ep.vid_index}
                {ep.locked && <Icon name="lock" class="episode-lock" />}
                {watching && <span class="episode-dot" />}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
