import { useState } from 'preact/hooks';
import { SOURCE_LABEL } from '../lib/format.js';

/** 3:4 poster card. `badge` overlays the top-left corner, `progress` (0–1) draws a bar. */
export function Poster({ item, onSelect, badge, subtitle, progress, showSource, attrs }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" class="poster focusable" tabIndex={-1} onClick={() => onSelect(item)} {...attrs}>
      <div class="poster-art">
        {item.cover && !broken
          ? <img src={item.cover} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
          : <div class="poster-fallback">{(item.series_title || '剧').slice(0, 2)}</div>}
        {item.rank ? <span class={'poster-rank' + (item.rank <= 3 ? ' is-top' : '')}>{item.rank}</span> : null}
        {badge ? <span class="poster-badge">{badge}</span> : null}
        {showSource && item.source ? <span class="poster-source">{SOURCE_LABEL[item.source] || item.source}</span> : null}
        {progress > 0 ? <span class="poster-progress"><i style={{ width: Math.min(100, progress * 100) + '%' }} /></span> : null}
      </div>
      <div class="poster-title">{item.series_title}</div>
      <div class="poster-meta">{subtitle != null ? subtitle : posterMeta(item)}</div>
    </button>
  );
}

function posterMeta(item) {
  const parts = [];
  if (item.heat) parts.push(item.heat);
  if (item.episode_count) parts.push('全' + item.episode_count + '集');
  if (!item.heat && item.tags && item.tags.length) parts.push(item.tags.slice(0, 2).join(' · '));
  return parts.join('  ');
}
