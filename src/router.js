import { createContext } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';

export const RouterContext = createContext(null);
export const ScreenContext = createContext({ active: true, id: 0 });

export function useRouter() {
  return useContext(RouterContext);
}

/** True while this screen is the top of the stack. */
export function useActive() {
  return useContext(ScreenContext).active;
}

/**
 * Register a key handler for the current screen. The handler receives the logical
 * action ('left', 'enter', 'back', 'playpause', ...) and the raw event, and returns
 * true when it consumed the key. Only the top screen's handlers run; the most
 * recently registered handler (e.g. an open dialog) runs first.
 */
export function useKeys(handler, enabled = true) {
  const router = useRouter();
  const { id } = useContext(ScreenContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    return router.addKeyHandler(id, (action, e) => ref.current(action, e));
  }, [enabled, id]);
}
