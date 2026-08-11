import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTelemetry } from '../context/TelemetryContext.jsx';
import { api } from '../services/api.js';
import { toast } from '../components/ui/Toast.jsx';

const TABS = [
  { key: 'main',  label: 'Асистент' },
  { key: 'issue', label: 'Проблема' },
];

export default function ChatPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { confirmDialog } = useTelemetry();

  const initialTab = TABS.some(t => t.key === location.state?.chat_type) ? location.state.chat_type : 'main';

  const [activeTab, setActiveTab] = useState(initialTab);
  const [messagesByType, setMessagesByType] = useState({ main: null, issue: null }); // null = not loaded yet
  const [draft, setDraft]     = useState(location.state?.seedMessage || '');
  const [isSending, setIsSending] = useState(false);

  const scrollRef = useRef(null);

  const messages = messagesByType[activeTab] || [];

  // ── Load history for a tab the first time it's opened ───────────────────────
  const loadTab = useCallback(async (chatType) => {
    try {
      const history = await api.getChatHistory(chatType);
      setMessagesByType(prev => ({ ...prev, [chatType]: history }));
    } catch (err) {
      toast.error(err.message || 'Не вдалося завантажити історію чату');
      setMessagesByType(prev => ({ ...prev, [chatType]: [] }));
    }
  }, []);

  useEffect(() => {
    if (messagesByType[activeTab] === null) loadTab(activeTab);
  }, [activeTab, messagesByType, loadTab]);

  const activeMessages = messagesByType[activeTab];
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [activeMessages]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || isSending) return;

    setDraft('');
    setIsSending(true);
    setMessagesByType(prev => ({
      ...prev,
      [activeTab]: [...(prev[activeTab] || []), { id: `local-${Date.now()}`, role: 'user', content: text }],
    }));

    try {
      const res = await api.sendMessage({ message: text, chat_type: activeTab });
      setMessagesByType(prev => ({
        ...prev,
        [activeTab]: [...(prev[activeTab] || []), { id: `reply-${Date.now()}`, role: 'assistant', content: res.reply }],
      }));
    } catch (err) {
      toast.error(err.message || 'Не вдалося надіслати повідомлення');
    } finally {
      setIsSending(false);
    }
  };

  const handleClear = async () => {
    const ok = await confirmDialog('Очистити історію цього чату? Дію не можна відмінити.');
    if (!ok) return;
    try {
      await api.clearChat(activeTab);
      setMessagesByType(prev => ({ ...prev, [activeTab]: [] }));
    } catch (err) {
      toast.error(err.message || 'Не вдалося очистити чат');
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] flex flex-col">
      {/* HEADER */}
      <div className="flex items-center justify-between px-5 pt-6 pb-3">
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
        </button>
        <h1 className="text-sm font-bold text-white uppercase tracking-widest">AI Асистент</h1>
        <button
          onClick={handleClear}
          className="w-9 h-9 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-950/40 transition-colors"
          aria-label="Очистити чат"
        >
          🗑
        </button>
      </div>

      {/* TABS */}
      <div className="flex bg-[#111318] rounded-2xl p-1 border border-gray-800 mx-5 mb-3">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === t.key ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* MESSAGES */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 flex flex-col gap-3 pb-4">
        {messagesByType[activeTab] === null ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-10 text-gray-500 text-xs px-6">
            {activeTab === 'main'
              ? 'Задайте питання про ваш автомобіль, діагностику чи обслуговування.'
              : 'Опишіть проблему з автомобілем — AI допоможе розібратись.'}
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-md'
                    : 'bg-[#111318] border border-gray-800 text-gray-200 rounded-bl-md'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))
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
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Напишіть повідомлення..."
          rows={1}
          className="flex-1 bg-[#111318] border border-gray-800 text-white text-sm rounded-2xl px-4 py-3 outline-none focus:border-blue-500 placeholder-gray-600 resize-none max-h-32"
        />
        <button
          onClick={handleSend}
          disabled={isSending || !draft.trim()}
          className="w-11 h-11 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center flex-shrink-0 transition-colors"
        >
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
        </button>
      </div>
    </div>
  );
}
