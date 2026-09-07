import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// App-wide layout CSS: safe-area variables, #root scroll container, the
// status-bar cover and the --app-height utilities. This used to be imported
// only by DashboardPage, which is lazy-loaded — so any route reached without
// loading that chunk (login, chat, leaderboard, public profile) rendered with
// NO safe-area handling at all, which is why the notch behaviour differed
// from page to page. It is global styling and belongs at the entry point.
import './App.css'
import App from './App.jsx'

// ── Hard-block pinch/double-tap zoom on iOS — everywhere EXCEPT the Leaflet
// map (ServicesPage), which needs real pinch-to-zoom ─────────────────────────
// The viewport meta tag's user-scalable=no + CSS touch-action aren't reliably
// honored by WKWebView on their own — 'gesturestart' is WebKit's own
// proprietary event for pinch gestures and is the one thing that actually
// stops it consistently. Also block any 2+ finger touchmove as a backstop.
const isInsideMap = (e) => e.target.closest?.('.leaflet-container');

document.addEventListener('gesturestart', (e) => {
  if (!isInsideMap(e)) e.preventDefault();
});
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1 && !isInsideMap(e)) e.preventDefault();
}, { passive: false });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
