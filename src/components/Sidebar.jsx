import { useState } from 'preact/hooks';
import { useRouter } from '../router.js';
import { Icon } from './Icon.jsx';

const ITEMS = [
  { tab: 'browse', label: '发现', icon: 'compass' },
  { tab: 'search', label: '搜索', icon: 'search' },
  { tab: 'history', label: '观看记录', icon: 'clock' },
  { tab: 'favorites', label: '我的追剧', icon: 'heart' },
  { tab: 'settings', label: '设置', icon: 'gear' },
];

/** Collapsed icon rail that expands over the content while it holds focus. */
export function Sidebar({ tab }) {
  const router = useRouter();
  // :focus-within needs Chromium 60; 2018–2019 TVs run 56–63, so track focus here.
  const [open, setOpen] = useState(false);
  return (
    <nav class={'sidebar' + (open ? ' is-open' : '')} data-focus-group="sidebar" aria-label="主导航"
      onFocusIn={() => setOpen(true)} onFocusOut={() => setOpen(false)}>
      <div class="sidebar-brand"><span class="brand-mark">红</span><span class="sidebar-label">红果短剧</span></div>
      <ul class="sidebar-list">
        {ITEMS.map(item => (
          <li key={item.tab}>
            <button type="button" class={'sidebar-item focusable' + (tab === item.tab ? ' is-current' : '')}
              tabIndex={-1} data-nav-left="none" data-sidebar-tab={item.tab}
              onClick={() => router.tab(item.tab)}>
              <Icon name={item.icon} />
              <span class="sidebar-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
