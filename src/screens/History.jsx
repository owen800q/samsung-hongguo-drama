import { useEffect, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { clearHistory, getFavorites, getHistory, isCompleted, removeHistory, subscribe } from '../lib/storage.js';
import { timeAgo } from '../lib/format.js';
import { PosterGrid } from '../components/PosterGrid.jsx';
import { TabRow } from '../components/TabRow.jsx';
import { Empty } from '../components/Status.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { Icon } from '../components/Icon.jsx';
import { toast } from '../components/Toast.jsx';

export function History() {
  const router = useRouter();
  const [items, setItems] = useState(getHistory);
  const [confirm, setConfirm] = useState(false);
  const [filter, setFilter] = useState('all');
  useEffect(() => subscribe(kind => { if (kind === 'history' || kind === 'favorites') setItems(getHistory()); }), []);

  // A 追剧 refresh that finds new episodes moves a finished series back to 未看完.
  const totals = {};
  getFavorites().forEach(f => { totals[f.series_id] = f.total; });
  const done = items.filter(item => isCompleted(item, totals[item.series_id]));
  const visible = filter === 'all' ? items : filter === 'completed' ? done : items.filter(item => done.indexOf(item) < 0);

  // Red key removes the focused entry.
  useKeys(action => {
    if (action !== 'red') return false;
    const el = document.activeElement;
    const i = el && el.getAttribute && el.getAttribute('data-index');
    if (i == null || !visible[i]) return false;
    removeHistory(visible[i].series_id);
    toast('已删除「' + visible[i].series_title + '」的观看记录');
    return true;
  });

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header page-header-row">
        <h1 class="page-title">观看记录</h1>
        {items.length > 0 && (
          <div class="page-tools">
            <span class="hint-inline"><b class="key-red" /> 删除选中</span>
            <button type="button" tabIndex={-1} class="btn btn-ghost focusable" onClick={() => setConfirm(true)}><Icon name="trash" />清空记录</button>
          </div>
        )}
      </header>
      {items.length > 0 && (
        <TabRow label="观看进度" group="history-filter" size="sm" value={filter} onChange={setFilter}
          items={[
            { value: 'all', label: '全部 ' + items.length },
            { value: 'unfinished', label: '未看完 ' + (items.length - done.length) },
            { value: 'completed', label: '已看完 ' + done.length },
          ]} />
      )}
      <section class="page-body">
        {visible.length > 0 ? (
          <PosterGrid items={visible} group="history-grid" autofocusFirst onSelect={item => router.push('detail', { series: item })}
            posterProps={item => ({
              badge: done.indexOf(item) >= 0 ? '已看完' : null,
              subtitle: '看到第' + item.vid_index + '集 · ' + timeAgo(item.updatedAt),
              progress: item.duration ? item.position / item.duration : 0,
            })} />
        ) : items.length > 0 ? (
          <Empty title={filter === 'completed' ? '还没有看完的剧' : '没有未看完的剧'}
            message="看完最后一集的剧会归入「已看完」；之后更新了新集会回到「未看完」。"
            secondaryLabel="查看全部" onSecondary={() => setFilter('all')} />
        ) : (
          <Empty title="还没有观看记录" message="在「发现」或「搜索」里挑一部剧开始看吧，进度会自动保存。" />
        )}
      </section>
      {confirm && (
        <Dialog title="清空全部观看记录？" message="清空后无法恢复，追剧列表不受影响。"
          actions={[{ label: '清空', danger: true, onSelect: () => { clearHistory(); setConfirm(false); } }, { label: '取消', autofocus: true, onSelect: () => setConfirm(false) }]}
          onClose={() => setConfirm(false)} />
      )}
    </div>
  );
}
