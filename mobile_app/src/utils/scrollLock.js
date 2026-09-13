/**
 * utils/scrollLock.js — stop the page behind an overlay from scrolling.
 *
 * The usual trick (`document.body.style.overflow = 'hidden'`) does nothing in
 * this app: App.css already pins `html, body` with `position: fixed; overflow:
 * hidden`, and makes **#root** the real scroll container. So the lock has to be
 * applied to #root, not to body.
 *
 * Ref-counted on purpose. Overlays stack here — ConfirmModal (z-200) can open
 * on top of the graph modal (z-110) — and if each one unlocked on close, the
 * first to close would hand scrolling back to the page while another overlay
 * was still up.
 *
 * Kept free of React so it can be tested directly; useScrollLock() is the thin
 * hook around it.
 */

// element → { count, prevOverflow, prevScrollTop }
const locks = new Map();

/** The element that actually scrolls (see App.css: #root is the container). */
export function getScrollRoot(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  return doc.getElementById?.('root') || doc.documentElement || null;
}

export function lockScroll(el) {
  if (!el) return;
  const existing = locks.get(el);
  if (existing) {
    // Another overlay is already holding the lock — just take a reference.
    existing.count++;
    return;
  }
  locks.set(el, {
    count: 1,
    prevOverflow: el.style.overflow,
    prevScrollTop: el.scrollTop || 0,
  });
  el.style.overflow = 'hidden';
}

export function unlockScroll(el) {
  if (!el) return;
  const state = locks.get(el);
  if (!state) return;          // never locked, or already fully released
  state.count--;
  if (state.count > 0) return; // something else still needs it locked

  el.style.overflow = state.prevOverflow || '';
  // Restoring overflow can clamp the scroll position, so put it back exactly
  // where the user left it — reopening a page must not jump to the top.
  el.scrollTop = state.prevScrollTop;
  locks.delete(el);
}

/** How many overlays currently hold the lock. Exposed for tests. */
export function lockDepth(el) {
  return locks.get(el)?.count ?? 0;
}

/** Test seam — drops all bookkeeping without touching the DOM. */
export function __resetLocks() {
  locks.clear();
}
