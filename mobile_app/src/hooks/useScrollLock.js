/**
 * hooks/useScrollLock.js — lock the page behind an open overlay.
 *
 * Call it unconditionally (hooks rules) and pass whether the overlay is open:
 *
 *   useScrollLock(!!selectedGraph || showHistoryModal);
 *
 * While active, #root — the app's scroll container — stops scrolling, so
 * swiping inside a modal can no longer drag the dashboard around behind it.
 * The lock is released automatically when the flag goes false or the component
 * unmounts, and is ref-counted so stacked overlays behave.
 */

import { useEffect } from 'react';
import { getScrollRoot, lockScroll, unlockScroll } from '../utils/scrollLock.js';

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    const el = getScrollRoot();
    if (!el) return undefined;
    lockScroll(el);
    return () => unlockScroll(el);
  }, [active]);
}

export default useScrollLock;
