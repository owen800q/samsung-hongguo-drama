// Spatial navigation for the remote's arrow keys.
//
// Focusable elements carry the `focusable` class (and a tabindex so they can take DOM
// focus). Arrow keys move to the nearest focusable in that direction inside the
// active scope: the top-most open `[data-focus-scope]` layer, or the whole page.
// `[data-focus-group]` containers remember their last focused child so leaving and
// re-entering a grid (e.g. sidebar → posters) returns to the same poster.

const SELECTOR = '.focusable:not([disabled])';
const groupMemory = new Map();

function activeScope() {
  const scopes = document.querySelectorAll('[data-focus-scope]');
  return scopes.length ? scopes[scopes.length - 1] : document.body;
}

function isVisible(el) {
  // Screens under the top one stay mounted with visibility:hidden, so they keep real
  // layout boxes but cannot take focus.
  if (el.closest('.is-covered')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function focusables(root) {
  return Array.prototype.filter.call((root || activeScope()).querySelectorAll(SELECTOR), isVisible);
}

function groupOf(el) {
  return el && el.closest ? el.closest('[data-focus-group]') : null;
}

export function current() {
  const el = document.activeElement;
  return el && el !== document.body && activeScope().contains(el) ? el : null;
}

/** Scroll the nearest `[data-scroll]` ancestor so `el` sits comfortably in view. */
export function revealElement(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const axis = node.getAttribute && node.getAttribute('data-scroll');
    if (axis) {
      const box = node.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const pad = Number(node.getAttribute('data-scroll-pad')) || 60;
      if (axis === 'y') {
        if (r.top < box.top + pad) node.scrollTop -= box.top + pad - r.top;
        else if (r.bottom > box.bottom - pad) node.scrollTop += r.bottom - (box.bottom - pad);
      } else {
        if (r.left < box.left + pad) node.scrollLeft -= box.left + pad - r.left;
        else if (r.right > box.right - pad) node.scrollLeft += r.right - (box.right - pad);
      }
    }
    node = node.parentElement;
  }
}

export function focusElement(el) {
  if (!el) return false;
  try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  revealElement(el);
  const group = groupOf(el);
  if (group) groupMemory.set(group.getAttribute('data-focus-group'), el);
  return true;
}

/** Focus by selector inside the active scope, falling back to the first focusable. */
export function focusFirst(selector, root) {
  const scope = root || activeScope();
  const el = (selector && scope.querySelector(selector)) || focusables(scope)[0];
  return focusElement(el);
}

/** Restore a group's remembered child, if it is still attached. */
export function restoreGroup(name) {
  const el = groupMemory.get(name);
  if (el && document.body.contains(el) && isVisible(el)) return focusElement(el);
  return false;
}

export function forgetGroup(name) {
  groupMemory.delete(name);
}

function centre(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Best candidate from `from` in `dir` ('left'|'right'|'up'|'down'). */
export function findNext(from, dir, candidates) {
  const a = from.getBoundingClientRect();
  const ac = centre(a);
  let best = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bc = centre(b);
    let primary, secondary, overlap;
    if (dir === 'right' || dir === 'left') {
      primary = dir === 'right' ? b.left - a.right : a.left - b.right;
      if ((dir === 'right' ? bc.x <= ac.x : bc.x >= ac.x)) continue;
      overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      secondary = Math.abs(bc.y - ac.y);
    } else {
      primary = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      if ((dir === 'down' ? bc.y <= ac.y : bc.y >= ac.y)) continue;
      overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      secondary = Math.abs(bc.x - ac.x);
    }
    primary = Math.max(0, primary);
    // Elements sharing a row/column win over diagonal neighbours.
    const score = primary + secondary * (overlap > 0 ? 0.3 : 2.5) + (overlap > 0 ? 0 : 400);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Move focus; returns false when nothing lies in that direction. */
export function move(dir) {
  const from = current();
  const candidates = focusables();
  if (!from) return focusElement(candidates[0]);
  const explicit = from.getAttribute('data-nav-' + dir);
  if (explicit) {
    if (explicit === 'none') return false;
    const target = activeScope().querySelector(explicit);
    if (target) return focusElement(target);
  }
  const next = findNext(from, dir, candidates);
  if (!next) return false;
  const fromGroup = groupOf(from);
  const toGroup = groupOf(next);
  if (toGroup && toGroup !== fromGroup && restoreGroup(toGroup.getAttribute('data-focus-group'))) return true;
  return focusElement(next);
}

// Track focus changes made by mouse/pointer (dev) or programmatic focus.
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', e => {
    const group = groupOf(e.target);
    if (group && e.target.classList && e.target.classList.contains('focusable')) {
      groupMemory.set(group.getAttribute('data-focus-group'), e.target);
    }
  });
}
