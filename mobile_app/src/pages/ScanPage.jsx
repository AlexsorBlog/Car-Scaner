import React, { useEffect, useState } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { api } from '../services/api.js';
import { compressImage } from '../utils/compressImage.js';
import { toast } from '../components/ui/Toast.jsx';

export default function ScanPage() {
  const [history, setHistory]   = useState(null); // null = loading
  const [isScanning, setIsScanning] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => {
    api.getChatHistory('photo')
      .then(setHistory)
      .catch((err) => { toast.error(err.message || 'Не вдалося завантажити історію сканувань'); setHistory([]); });
  }, []);

  const runScan = async (source) => {
    if (isScanning) return;
    setIsScanning(true);
    setLastResult(null);

    try {
      const photo = await Camera.getPhoto({
        source,
        resultType: CameraResultType.Uri,
        quality: 90,
      });

      setPreviewUrl(photo.webPath);

      const photoRes = await fetch(photo.webPath);
      const rawBlob  = await photoRes.blob();
      const compressed = await compressImage(rawBlob);

      const res = await api.sendMessage({
        message:   'Проаналізуй це фото автомобіля — опиши пошкодження, стан деталей та можливі проблеми.',
        chat_type: 'photo',
        imageFile: compressed,
      });

      setLastResult(res.reply);
      const fresh = await api.getChatHistory('photo');
      setHistory(fresh);
    } catch (err) {
      // User cancelling the native picker also lands here — don't show an
      // error toast for that specific case.
      if (!/cancel/i.test(err.message || '')) {
        console.error('[Scan] Camera/upload failed:', err.code, err.message, err);
        const label = err.code ? `[${err.code}] ${err.message || ''}` : (err.message || 'Не вдалося виконати сканування');
        toast.error(label);
      }
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="p-5 flex flex-col gap-6 animate-in fade-in duration-500">

      {/* Головний віджет ШІ аналізу */}
      <div className="bg-gradient-to-b from-blue-900/20 to-[#111318] rounded-3xl p-5 border border-blue-900/30 relative overflow-hidden shadow-[0_0_30px_rgba(37,99,235,0.1)] mt-4">
        <div className="absolute top-2 left-1/2 transform -translate-x-1/2 flex items-center gap-2 bg-black/50 px-3 py-1 rounded-full border border-gray-700 backdrop-blur-md">
          <div className={`w-1.5 h-1.5 rounded-full bg-red-500 ${isScanning ? 'animate-pulse' : ''}`}></div>
          <span className="text-[9px] font-bold tracking-widest uppercase text-gray-300">
            {isScanning ? 'Аналіз...' : 'Фото-діагностика'}
          </span>
        </div>

        <div className="mt-8 mb-6 h-40 border-2 border-dashed border-blue-500/30 rounded-xl flex items-center justify-center bg-blue-500/5 relative overflow-hidden">
          {previewUrl ? (
            <img src={previewUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <svg className="w-12 h-12 text-blue-500/50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          )}
          {isScanning && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        <h3 className="text-xs font-bold text-gray-400 mb-2 uppercase tracking-wider">Звіт AI</h3>
        {lastResult ? (
          <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{lastResult}</p>
        ) : (
          <p className="text-xs text-gray-500 leading-relaxed">
            Зробіть фото пошкодження чи деталі авто — AI опише стан і можливі проблеми.
          </p>
        )}

        <div className="flex justify-center gap-4 mt-6">
          <button
            onClick={() => runScan(CameraSource.Photos)}
            disabled={isScanning}
            className="flex items-center gap-2 px-4 h-10 rounded-full bg-gray-800 border border-gray-700 hover:bg-gray-700 transition-colors disabled:opacity-40 text-xs font-bold text-gray-200"
          >
            🖼 Галерея
          </button>
          <button
            onClick={() => runScan(CameraSource.Camera)}
            disabled={isScanning}
            className="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center shadow-[0_0_20px_rgba(37,99,235,0.4)] hover:scale-105 transition-transform disabled:opacity-40 disabled:hover:scale-100"
          >
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path></svg>
          </button>
        </div>
      </div>

      {/* Історія */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-bold tracking-wide text-gray-300">ІСТОРІЯ СКАНУВАНЬ</h3>
          <span className="text-[10px] text-gray-500 font-bold">
            {history === null ? '...' : `${history.filter(m => m.role === 'user').length} ЗВІТІВ`}
          </span>
        </div>

        <div className="flex flex-col gap-3">
          {history === null ? (
            <div className="flex justify-center py-6">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-xs">Історія сканувань порожня.</div>
          ) : (
            history
              .filter(m => m.role === 'assistant')
              .slice(-10)
              .reverse()
              .map(m => (
                <div key={m.id} className="bg-[#111318] p-4 rounded-xl border border-gray-800">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs flex-shrink-0">🔍</div>
                    <div className="text-[10px] text-gray-500">
                      {new Date(m.created_at).toLocaleString('uk-UA')}
                    </div>
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed line-clamp-3">{m.content}</p>
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}
