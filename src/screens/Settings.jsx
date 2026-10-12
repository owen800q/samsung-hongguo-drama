import { useState } from 'preact/hooks';
import { SOURCES } from '../sources/index.js';
import { clearHistory, clearSearches, getSettings, saveSettings } from '../lib/storage.js';
import { appVersion } from '../platform/tv.js';
import { Dialog } from '../components/Dialog.jsx';
import { toast } from '../components/Toast.jsx';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const STEPS = [5, 10, 15, 30];

function cycle(list, value) {
  const i = list.indexOf(value);
  return list[(i + 1) % list.length];
}

function Row({ label, value, hint, onSelect, autofocus }) {
  return (
    <button type="button" tabIndex={-1} class="setting-row focusable" onClick={onSelect} data-autofocus={autofocus ? '' : undefined}>
      <span class="setting-text"><span class="setting-label">{label}</span>{hint && <span class="setting-hint">{hint}</span>}</span>
      {value != null && <span class="setting-value">{value}</span>}
    </button>
  );
}

export function Settings() {
  const [s, setS] = useState(getSettings);
  const [confirm, setConfirm] = useState(false);
  const set = patch => setS(saveSettings(patch));
  const sourceLabel = (SOURCES.find(x => x.id === s.defaultSource) || SOURCES[0]).label;

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header"><h1 class="page-title">设置</h1></header>
      <section class="settings">
        <h2 class="section-title">播放</h2>
        <div class="settings-group" data-focus-group="settings">
          <Row label="自动播放下一集" hint="一集结束后接着播放" value={s.autoNext ? '开' : '关'} autofocus onSelect={() => set({ autoNext: !s.autoNext })} />
          <Row label="默认播放速度" value={s.playbackRate + '×'} onSelect={() => set({ playbackRate: cycle(RATES, s.playbackRate) })} />
          <Row label="快进 / 快退步长" hint="遥控器左右键每次跳过的秒数" value={s.seekStep + ' 秒'} onSelect={() => set({ seekStep: cycle(STEPS, s.seekStep) })} />
        </div>
        <h2 class="section-title">浏览</h2>
        <div class="settings-group">
          <Row label="默认来源" hint="打开「发现」时首先显示的来源" value={sourceLabel}
            onSelect={() => set({ defaultSource: cycle(SOURCES.map(x => x.id), s.defaultSource) })} />
          <Row label="清空搜索记录" onSelect={() => { clearSearches(); toast('搜索记录已清空'); }} />
          <Row label="清空观看记录" hint="追剧列表不受影响" onSelect={() => setConfirm(true)} />
        </div>
        <h2 class="section-title">关于</h2>
        <div class="about">
          <p><b>红果短剧 · 三星电视版</b> {appVersion()}</p>
          <p>社区维护的开源移植版，基于 hongguo-drama 桌面版，以 GPL-3.0 许可发布。不是红果、西饭或河马的官方客户端，也未获平台背书；不提供付费分集解锁，不保证所有剧集可播放。</p>
          <p>遥控器：方向键移动，确认键选择，返回键后退；播放时左右键快进快退，频道键切换剧集，绿色键选集，黄色键倍速。</p>
        </div>
      </section>
      {confirm && (
        <Dialog title="清空全部观看记录？" message="清空后无法恢复。"
          actions={[{ label: '清空', danger: true, onSelect: () => { clearHistory(); setConfirm(false); toast('观看记录已清空'); } }, { label: '取消', autofocus: true, onSelect: () => setConfirm(false) }]}
          onClose={() => setConfirm(false)} />
      )}
    </div>
  );
}
