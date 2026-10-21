import { useEffect, useRef, useState } from 'preact/hooks';
import { SOURCES } from '../sources/index.js';
import { clearHistory, clearSearches, getSettings, saveSettings } from '../lib/storage.js';
import { appVersion } from '../platform/tv.js';
import { Dialog } from '../components/Dialog.jsx';
import { toast } from '../components/Toast.jsx';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const STEPS = [5, 10, 15, 30];
const QUALITIES = ['auto', '720p', '1080p'];
const QUALITY_LABELS = { auto: '自动', '720p': '720P', '1080p': '1080P' };

// What the OTA loader's check reports (ota/ota.js), other than a downloaded build.
const UPDATE_RESULTS = {
  current: ['已是最新版本'],
  busy: ['正在后台检查更新，请稍后再试'],
  off: ['此安装包未启用在线更新，请从 GitHub Release 安装新版'],
  error: ['检查更新失败，请检查网络后重试', 'error'],
};

/** The loader that runs the packaged app (ota/ota.js); absent in development and in widgets built without updates. */
function ota() {
  return typeof window !== 'undefined' ? window.__ota : null;
}

function buildLabel() {
  const o = ota();
  return o && o.running ? '构建 ' + String(o.running).slice(0, 7) + (o.remote ? '（在线更新）' : '') : '';
}

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
  const [checking, setChecking] = useState(false);
  const [restart, setRestart] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const set = patch => setS(saveSettings(patch));
  const checkUpdate = () => {
    const o = ota();
    if (!o || typeof o.check !== 'function') { toast(UPDATE_RESULTS.off[0]); return; }
    if (checking) return;
    setChecking(true);
    o.check(result => {
      if (!mounted.current) return;
      setChecking(false);
      if (result === 'downloaded' || result === 'pending') { setRestart(true); return; }
      const [message, kind] = UPDATE_RESULTS[result] || UPDATE_RESULTS.error;
      toast(message, kind);
    });
  };
  const sourceLabel = (SOURCES.find(x => x.id === s.defaultSource) || SOURCES[0]).label;

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header"><h1 class="page-title">设置</h1></header>
      <section class="settings">
        <h2 class="section-title">播放</h2>
        <div class="settings-group" data-focus-group="settings">
          <Row label="自动播放下一集" hint="一集结束后接着播放" value={s.autoNext ? '开' : '关'} autofocus onSelect={() => set({ autoNext: !s.autoNext })} />
          <Row label="缓存下一集" hint="当前集开始播放就预先缓冲下一集，减少切集等待；会占用网络流量" value={s.cacheNext ? '开' : '关'} onSelect={() => set({ cacheNext: !s.cacheNext })} />
          <Row label="红果清晰度" hint="自动时官网片源优先；选 720P / 1080P 只用 App 片源（先缓冲整集），没有该清晰度会提示，不降级。仅对红果剧集有效"
            value={QUALITY_LABELS[s.hongguoQuality] || QUALITY_LABELS.auto} onSelect={() => set({ hongguoQuality: cycle(QUALITIES, s.hongguoQuality) })} />
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
        <div class="settings-group">
          <Row label="检查更新" hint="应用会在后台自动更新，下次打开时生效；也可以在这里立即检查，下载好后重新启动即可使用新版"
            value={checking ? '检查中…' : null} onSelect={checkUpdate} />
        </div>
        <div class="about">
          <p><b>红果短剧 · 三星电视版</b> {appVersion()}{buildLabel() && ' · ' + buildLabel()}</p>
          <p>社区维护的开源移植版，基于 hongguo-drama 桌面版，以 GPL-3.0 许可发布。不是红果、西饭或河马的官方客户端，也未获平台背书；不提供付费分集解锁，不保证所有剧集可播放。</p>
          <p>遥控器：方向键移动，确认键选择，返回键后退；播放时左右键快进快退，频道键切换剧集，绿色键选集，黄色键倍速。</p>
        </div>
      </section>
      {confirm && (
        <Dialog title="清空全部观看记录？" message="清空后无法恢复。"
          actions={[{ label: '清空', danger: true, onSelect: () => { clearHistory(); setConfirm(false); toast('观看记录已清空'); } }, { label: '取消', autofocus: true, onSelect: () => setConfirm(false) }]}
          onClose={() => setConfirm(false)} />
      )}
      {restart && (
        <Dialog title="新版本已下载" message="重新启动应用即可使用新版，也可以下次打开时再生效。"
          actions={[{ label: '立即重启', autofocus: true, onSelect: () => window.location.reload() }, { label: '稍后', onSelect: () => setRestart(false) }]}
          onClose={() => setRestart(false)} />
      )}
    </div>
  );
}
