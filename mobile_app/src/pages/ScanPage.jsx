import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { useTelemetry } from '../context/TelemetryContext.jsx';
import { api } from '../services/api.js';
import { compressImage } from '../utils/compressImage.js';
import { toast } from '../components/ui/Toast.jsx';

const DEFAULT_PHOTO_PROMPT = 'Проаналізуй це фото автомобіля — опиши пошкодження, стан деталей та можливі проблеми.';

export default function ScanPage() {
  const { confirmDialog } = useTelemetry();

  const [messages, setMessages] = useState(null); // null = loading
  const [draft, setDraft]       = useState('');
  const [isSending, setIsSending] = useState(false);

  const scrollRef = useRef(null);

  useEffect(() => {
    api.getChatHistory('photo')
      .then(setMessages)
      .catch((err) => { toast.error(err.message || 'Не вдалося завантажити історію'); setMessages([]); });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const reportError = (err) => {
    // User cancelling the native picker also lands here — don't show an
    // error toast for that specific case.
    if (/cancel/i.test(err.message || '')) return;
    console.error('[Scan] failed:', err.code, err.message, err);
    toast.error(err.code ? `[${err.code}] ${err.message || ''}` : (err.message || 'Не вдалося виконати запит'));
  };

  // ── Send a text-only message — chatting without a photo ─────────────────────
  const handleSendText = async () => {
    const text = draft.trim();
    if (!text || isSending) return;

    setDraft('');
    setIsSending(true);
    setMessages(prev => [...(prev || []), { id: `local-${Date.now()}`, role: 'user', content: text, content_json: null }]);

    try {
      const res = await api.sendMessage({ message: text, chat_type: 'photo' });
      setMessages(prev => [...prev, { id: `reply-${Date.now()}`, role: 'assistant', content: res.reply, content_json: null }]);
    } catch (err) {
      reportError(err);
    } finally {
      setIsSending(false);
    }
  };

  // ── Pick a photo (camera or gallery) and send it, with any typed text as caption ──
  const handlePickPhoto = useCallback(async (source) => {
    if (isSending) return;
    const caption = draft.trim();
    setDraft('');
    setIsSending(true);

    let localImageUrl = null;
    try {
      const photo = await Camera.getPhoto({ source, resultType: CameraResultType.Uri, quality: 90 });

      const photoRes   = await fetch(photo.webPath);
      const rawBlob    = await photoRes.blob();
      const compressed = await compressImage(rawBlob);
      localImageUrl    = URL.createObjectURL(compressed);

      setMessages(prev => [...(prev || []), {
        id: `local-${Date.now()}`, role: 'user', content: caption || '[image]',
        content_json: null, _localImageUrl: localImageUrl,
      }]);

      const res = await api.sendMessage({
        message:   caption || DEFAULT_PHOTO_PROMPT,
        chat_type: 'photo',
        imageFile: compressed,
      });

      setMessages(prev => [...prev, { id: `reply-${Date.now()}`, role: 'assistant', content: res.reply, content_json: null }]);
    } catch (err) {
      reportError(err);
    } finally {
      setIsSending(false);
    }
  }, [isSending, draft]);

  const handleClear = async () => {
    const ok = await confirmDialog('Очистити історію сканувань? Дію не можна відмінити.');
    if (!ok) return;
    try {
      await api.clearChat('photo');
      setMessages([]);
    } catch (err) {
      toast.error(err.message || 'Не вдалося очистити історію');
    }
  };

  return (
    // AppLayout reserves pb-24 (6rem) below <main> for the fixed BottomNav —
    // fill exactly that visible slot so the input bar stays pinned above the
    // nav instead of drifting below the fold in a taller-than-viewport page.
    <div className="h-[calc(100vh-6rem)] flex flex-col">
      {/* HEADER */}
      <div className="flex items-center justify-between px-5 pt-6 pb-3">
        <div>
          <h1 className="text-sm font-bold text-white uppercase tracking-widest">Фото-діагностика</h1>
          <p className="text-[10px] text-gray-500">Сфотографуйте авто або просто запитайте AI</p>
        </div>
        <button
          onClick={handleClear}
          className="w-9 h-9 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-950/40 transition-colors flex-shrink-0"
          aria-label="Очистити історію"
        >
          🗑
        </button>
      </div>

      {/* MESSAGES */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 flex flex-col gap-3 pb-4">
        {messages === null ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-10 text-gray-500 text-xs px-6">
            Зробіть фото пошкодження чи деталі авто, або просто напишіть питання — AI відповість.
          </div>
        ) : (
          messages.map((m) => {
            const isUser = m.role === 'user';
            const imgSrc = m.content_json?.base64
              ? `data:${m.content_json.mime || 'image/jpeg'};base64,${m.content_json.base64}`
              : m._localImageUrl || null;
            const showText = m.content && m.content !== '[image]';

            return (
              <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl overflow-hidden ${
                  isUser ? 'bg-blue-600 rounded-br-md' : 'bg-[#111318] border border-gray-800 rounded-bl-md'
                }`}>
                  {imgSrc && <img src={imgSrc} alt="" className="w-full max-h-64 object-cover" />}
                  {showText && (
                    <p className={`px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${isUser ? 'text-white' : 'text-gray-200'}`}>
                      {m.content}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
        {isSending && (
          <div className="flex justify-start">
            <div className="bg-[#111318] border border-gray-800 rounded-2xl rounded-bl-md px-4 py-3 flex gap-1">
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" />
            </div>
          </div>
        )}
      </div>

      {/* INPUT */}
      <div className="p-4 pb-safe border-t border-gray-800 bg-[#050505] flex items-end gap-2">
        <button
          onClick={() => handlePickPhoto(CameraSource.Photos)}
          disabled={isSending}
          className="w-11 h-11 rounded-full bg-gray-800 border border-gray-700 hover:bg-gray-700 disabled:opacity-40 flex items-center justify-center flex-shrink-0 transition-colors text-lg"
          aria-label="Галерея"
        >
          🖼
        </button>
        <button
          onClick={() => handlePickPhoto(CameraSource.Camera)}
          disabled={isSending}
          className="w-11 h-11 rounded-full bg-gray-800 border border-gray-700 hover:bg-gray-700 disabled:opacity-40 flex items-center justify-center flex-shrink-0 transition-colors"
          aria-label="Камера"
        >
          <svg className="w-5 h-5 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path></svg>
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); } }}
          placeholder="Напишіть питання про авто..."
          rows={1}
          className="flex-1 bg-[#111318] border border-gray-800 text-white text-sm rounded-2xl px-4 py-3 outline-none focus:border-blue-500 placeholder-gray-600 resize-none max-h-32"
        />
        <button
          onClick={handleSendText}
          disabled={isSending || !draft.trim()}
          className="w-11 h-11 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center flex-shrink-0 transition-colors"
          aria-label="Надіслати"
        >
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
        </button>
      </div>
    </div>
  );
}
