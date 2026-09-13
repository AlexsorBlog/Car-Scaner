/**
 * The page behind an open overlay must not scroll.
 *
 * Run: node src/utils/__tests__/scrollLock.test.mjs   (from mobile_app/)
 *
 * Note the target: App.css pins html/body already and makes #root the scroll
 * container, so locking `body` would be a no-op. These tests pin that down.
 */

import {
  getScrollRoot, lockScroll, unlockScroll, lockDepth, __resetLocks,
} from '../scrollLock.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

const makeEl = (scrollTop = 0, overflow = '') => ({ style: { overflow }, scrollTop });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Locking and releasing\n');

__resetLocks();
const el = makeEl(450, 'auto');

lockScroll(el);
check('the scroll container stops scrolling while an overlay is open',
  el.style.overflow === 'hidden', el.style.overflow);

unlockScroll(el);
check('scrolling is handed back when the overlay closes',
  el.style.overflow === 'auto', el.style.overflow);
check('the page stays exactly where the user had scrolled to — no jump to top',
  el.scrollTop === 450, String(el.scrollTop));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Stacked overlays (ConfirmModal over the graph modal)\n');

__resetLocks();
const stacked = makeEl(120, 'auto');

lockScroll(stacked);   // graph modal opens
lockScroll(stacked);   // ConfirmModal opens on top
check('both overlays hold the lock', lockDepth(stacked) === 2, String(lockDepth(stacked)));

unlockScroll(stacked); // ConfirmModal closes
check('the page is STILL locked while the graph modal remains open',
  stacked.style.overflow === 'hidden' && lockDepth(stacked) === 1,
  `${stacked.style.overflow} / depth ${lockDepth(stacked)}`);

unlockScroll(stacked); // graph modal closes
check('only the last overlay to close restores scrolling',
  stacked.style.overflow === 'auto' && lockDepth(stacked) === 0,
  stacked.style.overflow);
check('scroll position survives the whole stack', stacked.scrollTop === 120);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Misuse must not break the app\n');

__resetLocks();
const lone = makeEl(10, 'auto');
unlockScroll(lone);
check('unlocking something that was never locked is a no-op',
  lone.style.overflow === 'auto' && lockDepth(lone) === 0);

lockScroll(lone);
unlockScroll(lone);
unlockScroll(lone);   // double release (e.g. StrictMode double-invoke)
check('an extra release does not leave the page stuck or re-lock it',
  lone.style.overflow === 'auto' && lockDepth(lone) === 0, lone.style.overflow);

check('null elements are tolerated', (() => {
  lockScroll(null); unlockScroll(null); return true;
})());

__resetLocks();
const blank = makeEl(0, '');
lockScroll(blank);
unlockScroll(blank);
check('an element with no inline overflow is restored to none, not "undefined"',
  blank.style.overflow === '', JSON.stringify(blank.style.overflow));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] It targets the right element\n');

const fakeDoc = {
  getElementById: (id) => (id === 'root' ? { id: 'root', style: {}, scrollTop: 0 } : null),
  documentElement: { id: 'html', style: {}, scrollTop: 0 },
};
check('#root is the lock target — body/html is already pinned by App.css',
  getScrollRoot(fakeDoc)?.id === 'root', getScrollRoot(fakeDoc)?.id);

check('falls back to documentElement if #root is somehow absent',
  getScrollRoot({ getElementById: () => null, documentElement: { id: 'html' } })?.id === 'html');
check('no document at all returns null instead of throwing',
  getScrollRoot(null) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
