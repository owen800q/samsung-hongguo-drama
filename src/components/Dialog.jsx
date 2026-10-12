import { useEffect, useRef } from 'preact/hooks';
import { useRouter } from '../router.js';
import { focusFirst } from '../lib/focus.js';

/** Modal confirmation. Traps arrow navigation; Back closes it. */
export function Dialog({ title, message, actions, onClose }) {
  const router = useRouter();
  const ref = useRef(null);
  const previous = useRef(document.activeElement);
  useEffect(() => {
    focusFirst('[data-autofocus]', ref.current);
    const off = router.addKeyHandler('global', action => {
      if (action === 'back') { onClose(); return true; }
      return !['left', 'right', 'up', 'down', 'enter'].includes(action);
    });
    return () => {
      off();
      const el = previous.current;
      if (el && document.body.contains(el)) setTimeout(() => el.focus(), 0);
    };
  }, []);
  return (
    <div class="dialog-backdrop" data-focus-scope ref={ref}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2 class="dialog-title">{title}</h2>
        {message && <p class="dialog-message">{message}</p>}
        <div class="dialog-actions">
          {actions.map(a => (
            <button key={a.label} type="button" tabIndex={-1} data-autofocus={a.autofocus ? '' : undefined}
              class={'btn focusable' + (a.danger ? ' btn-danger' : '')} onClick={a.onSelect}>{a.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
