import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api.js';
import { toast } from '../components/ui/Toast.jsx';

const FILTER_LABELS = {
  '0-50':    '0-50 км/год',
  '50-100':  '50-100 км/год',
  '0-100':   '0-100 км/год',
  '100-200': '100-200 км/год',
  '0-200':   '0-200 км/год',
  '60-130':  '60-130 км/год',
  '1/4mi':   '1/4 милі',
  '1/2mi':   '1/2 милі',
};

const formatTime = (ms) => (ms / 1000).toFixed(2) + ' с';

// ── Small inline SVG speed-vs-time graph — no need for a full chart lib for a
// single-series [{t,v}] array like this ────────────────────────────────────
function SpeedGraph({ telemetry }) {
  if (!telemetry || telemetry.length < 2) {
    return <div className="h-32 flex items-center justify-center text-[10px] text-gray-600">Немає даних телеметрії</div>;
  }

  const W = 300, H = 110, PAD = 8;
  const ts = telemetry.map(p => p.t);
  const vs = telemetry.map(p => p.v);
  const tMin = Math.min(...ts), tMax = Math.max(...ts) || 1;
  const vMin = 0, vMax = Math.max(...vs) || 1;

  const x = (t) => PAD + ((t - tMin) / (tMax - tMin || 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - vMin) / (vMax - vMin || 1)) * (H - PAD * 2);

  const points = telemetry.map(p => `${x(p.t)},${y(p.v)}`).join(' ');
  const areaPoints = `${x(ts[0])},${H - PAD} ${points} ${x(ts[ts.length - 1])},${H - PAD}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32">
      <polygon points={areaPoints} fill="url(#speedGradient)" opacity="0.25" />
      <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id="speedGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <text x={PAD} y={H - 2} className="fill-gray-500" style={{ font: '9px sans-serif' }}>0 км/год</text>
      <text x={W - PAD} y={H - 2} textAnchor="end" className="fill-gray-500" style={{ font: '9px sans-serif' }}>{Math.round(vMax)} км/год</text>
    </svg>
  );
}

export default function PublicProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getPublicProfile(id)
      .then(setData)
      .catch((err) => {
        setError(err.message || 'Не вдалося завантажити профіль');
        toast.error(err.message || 'Не вдалося завантажити профіль');
      });
  }, [id]);

  return (
    <div className="min-h-screen bg-[#050505] pb-10">
      <div className="flex items-center justify-between px-5 pt-6 mb-6">
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
        </button>
        <h1 className="text-sm font-bold text-white uppercase tracking-widest">Профіль гонщика</h1>
        <div className="w-9" />
      </div>

      {data === null ? (
        error ? (
          <div className="text-center py-10 text-gray-500 text-xs px-6">{error}</div>
        ) : (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )
      ) : (
        <div className="px-5 flex flex-col gap-6">
          {/* HEADER CARD */}
          <div className="flex flex-col items-center">
            <div className="w-24 h-24 rounded-full border-4 border-gray-800 bg-gradient-to-tr from-gray-700 to-gray-600 flex items-center justify-center text-3xl shadow-xl overflow-hidden">
              {data.user.avatar_base64 ? (
                <img
                  src={`data:${data.user.avatar_mime || 'image/jpeg'};base64,${data.user.avatar_base64}`}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                '👤'
              )}
            </div>
            <h2 className="text-xl font-bold text-white mt-4">{data.user.name || 'Анонім'}</h2>
            <p className="text-sm text-gray-500">
              {[data.user.car_brand, data.user.car_model].filter(Boolean).join(' ') || 'Авто не вказано'}
            </p>
          </div>

          {/* RECORDS */}
          <div>
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Рекорди</h3>
            {data.records.length === 0 ? (
              <div className="text-center py-8 text-gray-500 text-xs">Ще немає збережених заїздів.</div>
            ) : (
              <div className="flex flex-col gap-4">
                {data.records.map((r) => (
                  <div key={r.filter_key} className="bg-[#111318] rounded-2xl border border-gray-800 p-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-bold text-gray-300">{FILTER_LABELS[r.filter_key] || r.filter_key}</span>
                      <span className="text-sm font-black text-blue-400">{formatTime(r.time_ms)}</span>
                    </div>
                    <SpeedGraph telemetry={r.telemetry} />
                    <div className="text-[10px] text-gray-600 mt-1">
                      {r.distance_m ? `${r.distance_m.toFixed(0)} м · ` : ''}
                      {new Date(r.recorded_at).toLocaleDateString('uk-UA')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
