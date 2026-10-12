import { useEffect, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { fetchSeries } from '../sources/index.js';
import { getFavorites, getHistoryEntry, subscribe, toggleFavorite, updateFavorite } from '../lib/storage.js';
import { PosterGrid } from '../components/PosterGrid.jsx';
import { Empty } from '../components/Status.jsx';
import { toast } from '../components/Toast.jsx';

const RECHECK_MS = 30 * 60 * 1000;

/** Re-read episode counts for stale favourites, three at a time. */
function refreshCounts(list) {
  const stale = list.filter(x => Date.now() - (x.checkedAt || 0) > RECHECK_MS);
  let i = 0;
  const worker = () => {
    const item = stale[i++];
    if (!item) return Promise.resolve();
    return fetchSeries(item.series_id).then(res => updateFavorite(item.series_id, res.total, false), () => {}).then(worker);
  };
  return Promise.all([worker(), worker(), worker()]);
}

export function Favorites() {
  const router = useRouter();
  const [items, setItems] = useState(getFavorites);
  useEffect(() => subscribe(kind => { if (kind === 'favorites') setItems(getFavorites()); }), []);
  useEffect(() => { refreshCounts(getFavorites()); }, []);

  useKeys(action => {
    if (action !== 'red') return false;
    const el = document.activeElement;
    const i = el && el.getAttribute && el.getAttribute('data-index');
    if (i == null || !items[i]) return false;
    toggleFavorite(items[i]);
    toast('已取消追剧「' + items[i].series_title + '」');
    return true;
  });

  const updates = items.filter(x => x.total > (x.seenTotal || 0)).length;

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header page-header-row">
        <h1 class="page-title">我的追剧</h1>
        {items.length > 0 && (
          <div class="page-tools">
            {updates > 0 && <span class="pill-accent">{updates} 部有更新</span>}
            <span class="hint-inline"><b class="key-red" /> 取消追剧</span>
          </div>
        )}
      </header>
      <section class="page-body">
        {items.length > 0 ? (
          <PosterGrid items={items} group="favorites-grid" autofocusFirst onSelect={item => router.push('detail', { series: item })}
            posterProps={item => {
              const h = getHistoryEntry(item.series_id);
              const fresh = item.total - (item.seenTotal || 0);
              return {
                badge: fresh > 0 ? '更新 ' + fresh + ' 集' : null,
                subtitle: (h ? '看到第' + h.vid_index + '集 · ' : '') + '共' + item.total + '集',
                progress: h && item.total ? h.vid_index / item.total : 0,
              };
            }} />
        ) : (
          <Empty title="还没有追的剧" message="在剧集详情页按「追剧」，有新集数更新时会在这里提醒你。" />
        )}
      </section>
    </div>
  );
}
