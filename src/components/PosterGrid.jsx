import { Poster } from './Poster.jsx';

/**
 * Wrapping poster grid. Calls `onNearEnd` when a poster in the last two rows takes
 * focus so the screen can fetch the next page before the user reaches the bottom.
 */
export function PosterGrid({ items, group, columns = 6, onSelect, onNearEnd, posterProps, showSource, autofocusFirst }) {
  const threshold = Math.max(0, items.length - columns * 2);
  return (
    <div class="poster-grid" data-focus-group={group}>
      {items.map((item, i) => (
        <Poster key={item.series_id + ':' + i} item={item} onSelect={onSelect} showSource={showSource}
          {...(posterProps ? posterProps(item) : null)}
          attrs={{ onFocus: onNearEnd && i >= threshold ? onNearEnd : undefined, 'data-index': i, 'data-autofocus': autofocusFirst && i === 0 ? '' : undefined }} />
      ))}
    </div>
  );
}
