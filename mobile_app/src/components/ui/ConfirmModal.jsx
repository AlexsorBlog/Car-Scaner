/**
 * components/ui/ConfirmModal.jsx
 *
 * Replaces window.confirm() which is silently ignored in Capacitor native apps.
 * Driven by the `confirmState` value from TelemetryContext.
 */

import { useTelemetry } from '../../context/TelemetryContext.jsx';

export default function ConfirmModal() {
  const { confirmState } = useTelemetry();
  if (!confirmState) return null;

  const { message, onConfirm, onCancel } = confirmState;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full bg-[#0b0c10] border-t border-gray-800 rounded-t-3xl p-6 pb-10 shadow-2xl animate-in slide-in-from-bottom-6 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-5" />

        <p className="text-sm text-gray-300 text-center mb-6 leading-relaxed px-2">
          {message}
        </p>

        <div className="flex flex-col gap-3">
          <button
            onClick={onConfirm}
            className="w-full py-4 bg-red-600 hover:bg-red-500 text-white font-bold rounded-2xl transition-colors text-sm"
          >
            Підтвердити
          </button>
          <button
            onClick={onCancel}
            className="w-full py-4 bg-gray-800 hover:bg-gray-700 text-gray-300 font-bold rounded-2xl transition-colors text-sm border border-gray-700"
          >
            Скасувати
          </button>
        </div>
      </div>
    </div>
  );
}