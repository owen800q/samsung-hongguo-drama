/** Horizontal row of selectable chips (sources, categories, genres). Scrolls with focus. */
export function TabRow({ items, value, onChange, group, size, label, autofocus }) {
  return (
    <div class={'tab-row' + (size ? ' tab-row-' + size : '')} data-scroll="x" data-scroll-pad="120" role="tablist" aria-label={label}>
      <div class="tab-row-track" data-focus-group={group}>
        {items.map(item => (
          <button key={item.value} type="button" role="tab" aria-selected={item.value === value} tabIndex={-1}
            class={'chip focusable' + (item.value === value ? ' is-selected' : '')}
            data-autofocus={autofocus && item.value === value ? '' : undefined}
            onClick={() => onChange(item.value)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
