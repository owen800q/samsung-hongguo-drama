import { Icon } from './Icon.jsx';

export function Spinner({ label }) {
  return (
    <div class="status">
      <span class="spinner" aria-hidden="true" />
      {label && <span class="status-text">{label}</span>}
    </div>
  );
}

/** Empty or error state with an optional retry button and a second way out. */
export function Empty({ title, message, actionLabel, onAction, autofocus, secondaryLabel, onSecondary }) {
  return (
    <div class="status status-empty">
      <div class="status-title">{title}</div>
      {message && <div class="status-text">{message}</div>}
      {(onAction || onSecondary) && (
        <div class="status-actions">
          {onAction && (
            <button type="button" tabIndex={-1} class="btn focusable" data-autofocus={autofocus ? '' : undefined} onClick={onAction}>
              <Icon name="refresh" />{actionLabel || '重试'}
            </button>
          )}
          {onSecondary && (
            <button type="button" tabIndex={-1} class="btn btn-ghost focusable" onClick={onSecondary}>{secondaryLabel}</button>
          )}
        </div>
      )}
    </div>
  );
}

/** Skeleton posters while the first page loads. */
export function PosterSkeleton({ count = 12 }) {
  const cells = [];
  for (let i = 0; i < count; i++) cells.push(<div key={i} class="poster poster-skeleton"><div class="poster-art" /><div class="skeleton-line" /><div class="skeleton-line short" /></div>);
  return <div class="poster-grid">{cells}</div>;
}
