/**
 * components/ui/Toast.jsx
 *
 * Lightweight toast system — replaces alert() calls which don't work in Capacitor.
 *
 * Usage:
 *   import { toast } from './Toast.jsx';
 *   toast.success('Помилки стерто!');
 *   toast.error('Помилка підключення');
 *   toast.info('Сканування...');
 *
 * Mount <ToastContainer /> once inside AppLayout.
 */

import { useEffect, useState } from 'react';

// ── Simple event bus (no external lib needed) ─────────────────────────────────

const listeners = new Set();
let _nextId = 0;

export const toast = {
  show(message, type = 'info', durationMs = 3000) {
    const id = ++_nextId;
    listeners.forEach(fn => fn({ id, message, type, durationMs }));
  },
  success(msg, ms)  { this.show(msg, 'success', ms); },
  error(msg, ms)    { this.show(msg, 'error',   ms ?? 4000); },
  info(msg, ms)     { this.show(msg, 'info',    ms); },
  warn(msg, ms)     { this.show(msg, 'warning', ms); },
};

// ── ToastContainer ────────────────────────────────────────────────────────────

const TYPE_STYLES = {
  success: { bg: 'bg-green-900/90',  border: 'border-green-700',  icon: '✓', color: 'text-green-400' },
  error:   { bg: 'bg-red-900/90',    border: 'border-red-700',    icon: '✕', color: 'text-red-400'   },
  warning: { bg: 'bg-yellow-900/90', border: 'border-yellow-700', icon: '!', color: 'text-yellow-400'},
  info:    { bg: 'bg-gray-800/90',   border: 'border-gray-700',   icon: 'i', color: 'text-blue-400'  },
};

export function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handler = (t) => {
      setToasts(prev => [...prev, t]);
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== t.id));
      }, t.durationMs ?? 3000);
    };
    listeners.add(handler);
    return () => listeners.delete(handler);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 left-0 right-0 z-[300] flex flex-col items-center gap-2 px-4 pointer-events-none">
      {toasts.map((t) => {
        const s = TYPE_STYLES[t.type] ?? TYPE_STYLES.info;
        return (
          <div
            key={t.id}
            className={`
              flex items-center gap-3 px-4 py-3 rounded-2xl border backdrop-blur-md
              shadow-[0_8px_32px_rgba(0,0,0,0.4)] pointer-events-auto
              animate-in slide-in-from-top-3 duration-200
              ${s.bg} ${s.border}
            `}
          >
            <span className={`text-xs font-bold w-4 h-4 rounded-full border flex items-center justify-center ${s.color} border-current`}>
              {s.icon}
            </span>
            <span className="text-sm text-gray-200 font-medium">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}