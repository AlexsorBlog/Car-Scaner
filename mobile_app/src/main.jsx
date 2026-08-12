import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// ── Hard-block pinch/double-tap zoom on iOS ──────────────────────────────────
// The viewport meta tag's user-scalable=no + CSS touch-action aren't reliably
// honored by WKWebView on their own — 'gesturestart' is WebKit's own
// proprietary event for pinch gestures and is the one thing that actually
// stops it consistently. Also block any 2+ finger touchmove as a backstop.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
