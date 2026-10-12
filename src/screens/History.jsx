import { useEffect, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { clearHistory, getHistory, removeHistory, subscribe } from '../lib/storage.js';
import { timeAgo } from '../lib/format.js';
import { PosterGrid } from '../components/PosterGrid.jsx';
import { Empty } from '../components/Status.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { Icon } from '../components/Icon.jsx';
import { toast } from '../components/Toast.jsx';

export function History() {
  const router = useRouter();
  const [items, setItems] = useState(getHistory);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => subscribe(kind => { if (kind === 'history') setItems(getHistory()); }), []);

  // Red key removes the focused entry.
  useKeys(action => {
    if (action !== 'red') return false;
    const el = document.activeElement;
    const i = el && el.getAttribute && el.getAttribute('data-index');
    if (i == null || !items[i]) return false;
    removeHistory(items[i].series_id);
    toast('已删除「' + items[i].series_title + '」的观看记录');
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
      <section class="page-body">
        {items.length > 0 ? (
          <PosterGrid items={items} group="history-grid" autofocusFirst onSelect={item => router.push('detail', { series: item })}
            posterProps={item => ({
              subtitle: '看到第' + item.vid_index + '集 · ' + timeAgo(item.updatedAt),
              progress: item.duration ? item.position / item.duration : 0,
            })} />
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
