import { useEffect, useState } from 'preact/hooks';

let push = null;
const queue = [];

/** Fire-and-forget message shown at the bottom of the screen. */
export function toast(message, kind) {
  const item = { id: Date.now() + Math.random(), message: String(message || ''), kind: kind || 'info' };
  if (push) push(item);
  else queue.push(item);
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    push = item => {
      setItems(list => list.concat([item]).slice(-3));
      setTimeout(() => setItems(list => list.filter(x => x.id !== item.id)), 3600);
    };
    queue.splice(0).forEach(push);
    return () => { push = null; };
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map(item => <div key={item.id} class={'toast toast-' + item.kind}>{item.message}</div>)}
    </div>
  );
}
