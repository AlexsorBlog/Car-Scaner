import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api.js';
import { toast } from '../components/ui/Toast.jsx';

const PAGE_SIZE = 20;

const FILTERS = [
  { value: '0-50',    label: '0-50 км/год' },
  { value: '50-100',  label: '50-100 км/год' },
  { value: '0-100',   label: '0-100 км/год' },
  { value: '100-200', label: '100-200 км/год' },
  { value: '0-200',   label: '0-200 км/год' },
  { value: '60-130',  label: '60-130 км/год' },
  { value: '1/4mi',   label: '1/4 милі (402 м)' },
  { value: '1/2mi',   label: '1/2 милі (804 м)' },
];

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

const formatTime = (ms) => (ms / 1000).toFixed(2) + ' с';

export default function LeaderboardPage() {
  const navigate = useNavigate();

  const [filter, setFilter]       = useState('0-100');
  const [brandInput, setBrandInput] = useState('');
  const [brand, setBrand]         = useState('');

  const [board, setBoard]         = useState([]);
  const [myRank, setMyRank]       = useState(null);
  const [offset, setOffset]       = useState(0);
  const [hasMore, setHasMore]     = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // ── Debounce the brand search box ────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setBrand(brandInput.trim()), 400);
    return () => clearTimeout(t);
  }, [brandInput]);

  // ── (Re)load from scratch whenever filter/brand changes ─────────────────────
  const loadFirstPage = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.leaderboard(filter, brand, 0, PAGE_SIZE);
      setBoard(res.board || []);
      setMyRank(res.my_rank ?? null);
      setOffset((res.board || []).length);
      setHasMore(!!res.has_more);
    } catch (err) {
      toast.error(err.message || 'Не вдалося завантажити рейтинг');
      setBoard([]);
      setHasMore(false);
    } finally {
      setIsLoading(false);
    }
  }, [filter, brand]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const res = await api.leaderboard(filter, brand, offset, PAGE_SIZE);
      setBoard(prev => [...prev, ...(res.board || [])]);
      setOffset(prev => prev + (res.board || []).length);
      setHasMore(!!res.has_more);
    } catch (err) {
      toast.error(err.message || 'Не вдалося завантажити ще');
    } finally {
      setIsLoadingMore(false);
    }
  }, [filter, brand, offset, hasMore, isLoadingMore]);

  // ── Infinite scroll sentinel ──────────────────────────────────────────────────
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [loadMore]);

  const myRankLabel = useMemo(() => {
    if (myRank == null) return 'Ще немає результатів у цьому фільтрі';
    return `Ваша позиція: #${myRank}`;
  }, [myRank]);

  return (
    <div className="min-h-[100dvh] bg-[#050505] pb-10">
      {/* HEADER */}
      <div className="flex justify-between items-center px-5 pt-6 mb-4">
        <div>
          <h1 className="text-lg font-black text-white">Рейтинг</h1>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest">Топ-100 · {FILTERS.find(f => f.value === filter)?.label}</p>
        </div>
        <button
          onClick={() => navigate('/profile')}
          className="w-9 h-9 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          aria-label="Закрити"
        >
          ✕
        </button>
      </div>

      {/* FILTERS */}
      <div className="px-5 flex flex-col gap-3 mb-4">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full bg-[#111318] border border-gray-800 text-white text-sm rounded-xl px-4 py-3 outline-none focus:border-blue-500"
        >
          {FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <input
          type="text"
          value={brandInput}
          onChange={(e) => setBrandInput(e.target.value)}
          placeholder="Пошук за маркою авто (BMW, Toyota...)"
          className="w-full bg-[#111318] border border-gray-800 text-white text-sm rounded-xl px-4 py-3 outline-none focus:border-blue-500 placeholder-gray-600"
        />
      </div>

      {/* MY RANK */}
      <div className="px-5 mb-4">
        <div className="bg-gradient-to-br from-blue-900/30 to-[#111318] border border-blue-800/40 rounded-2xl p-4 flex items-center justify-between">
          <span className="text-sm font-bold text-blue-300">{myRankLabel}</span>
          {myRank != null && <span className="text-2xl">{MEDALS[myRank] || '🏁'}</span>}
        </div>
      </div>

      {/* LIST */}
      <div className="px-5 flex flex-col gap-2">
        {isLoading ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : board.length === 0 ? (
          <div className="text-center py-10 text-gray-500 text-xs">Нічого не знайдено за цим фільтром.</div>
        ) : (
          board.map((entry) => (
            <button
              key={`${entry.rank}-${entry.user_id}`}
              onClick={() => navigate(`/leaderboard/user/${entry.user_id}`)}
              className={`w-full flex items-center gap-3 p-3.5 rounded-xl border text-left transition-colors ${
                entry.is_me
                  ? 'bg-blue-900/20 border-blue-700/50 hover:bg-blue-900/30'
                  : 'bg-[#111318] border-gray-800 hover:bg-[#161922]'
              }`}
            >
              <div className="w-8 text-center font-black text-sm text-gray-400">
                {MEDALS[entry.rank] || `#${entry.rank}`}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white truncate">
                  {entry.name || 'Анонім'}{entry.is_me && <span className="text-blue-400"> (Ви)</span>}
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  {[entry.car_brand, entry.car_model].filter(Boolean).join(' ') || 'Авто не вказано'}
                </div>
              </div>
              <div className="text-sm font-black text-blue-400 flex-shrink-0">{formatTime(entry.time_ms)}</div>
            </button>
          ))
        )}

        {/* Infinite-scroll sentinel */}
        {!isLoading && hasMore && (
          <div ref={sentinelRef} className="flex justify-center py-4">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {!isLoading && !hasMore && board.length > 0 && (
          <div className="text-center py-4 text-[10px] text-gray-600 uppercase tracking-widest">Це всі результати</div>
        )}
      </div>
    </div>
  );
}
