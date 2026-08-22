import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api.js';
import { toast } from '../components/ui/Toast.jsx';
import { DragyStyleChart } from '../components/perf/DragyStyleChart.jsx';
import PerfRunDetailModal from '../components/perf/PerfRunDetailModal.jsx';
import { formatPerfTime, getMilestoneTime } from '../components/perf/perfHelpers.js';

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

export default function PublicProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [selectedRecord, setSelectedRecord] = useState(null);

  useEffect(() => {
    api.getPublicProfile(id)
      .then(setData)
      .catch((err) => {
        setError(err.message || 'Не вдалося завантажити профіль');
        toast.error(err.message || 'Не вдалося завантажити профіль');
      });
  }, [id]);

  return (
    <div className="min-h-[100dvh] bg-[#050505] pb-10">
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
                {data.records.map((r) => {
                  const telemetry = r.telemetry || [];
                  const hasDetailedTelemetry = telemetry.length > 1 && telemetry[0]?.speed !== undefined;
                  const displayTime = getMilestoneTime(telemetry, r.filter_key) || r.time_ms;

                  return (
                    <div key={r.filter_key} className="bg-[#111318] rounded-2xl border border-gray-800 overflow-hidden">
                      <button
                        onClick={() => hasDetailedTelemetry && setSelectedRecord(r)}
                        className="w-full text-left px-4 pt-4 pb-2 flex justify-between items-start"
                      >
                        <div>
                          <span className="text-xs font-bold text-gray-300">{FILTER_LABELS[r.filter_key] || r.filter_key}</span>
                          <div className="text-[10px] text-gray-600 mt-0.5">
                            {new Date(r.recorded_at).toLocaleString('uk-UA')}
                            {r.distance_m ? ` · ${r.distance_m.toFixed(0)} м` : ''}
                          </div>
                        </div>
                        <span className="text-sm font-black text-blue-400 tabular-nums">{formatPerfTime(displayTime)}</span>
                      </button>

                      {hasDetailedTelemetry ? (
                        <div className="px-2 pb-2">
                          <DragyStyleChart runData={telemetry} />
                          <button
                            onClick={() => setSelectedRecord(r)}
                            className="w-full text-center text-[10px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-xl py-2 mt-1"
                          >
                            Детальніше →
                          </button>
                        </div>
                      ) : (
                        <div className="px-4 pb-4 text-[10px] text-gray-600">Немає детальної телеметрії для цього заїзду.</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {selectedRecord && (
        <PerfRunDetailModal
          timestamp={selectedRecord.recorded_at}
          timeMs={selectedRecord.time_ms}
          telemetry={selectedRecord.telemetry}
          filterKey={selectedRecord.filter_key}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </div>
  );
}
