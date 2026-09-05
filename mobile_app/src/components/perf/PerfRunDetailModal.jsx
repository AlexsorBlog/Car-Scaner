import React from 'react';
import { DragyStyleChart } from './DragyStyleChart.jsx';
import { formatPerfTime, getMilestoneTime, getMilestoneDistance } from './perfHelpers.js';

/**
 * components/perf/PerfRunDetailModal.jsx
 * Shared "run detail" modal — same DragyStyleChart, same stats grid, same
 * step-by-step telemetry table — used by both DashboardPage (your own local
 * runs) and PublicProfilePage (anyone's best runs from the leaderboard), so
 * both show "fully same info" from the same source.
 *
 * Props:
 *  - timestamp: ms epoch or ISO string — when the run happened
 *  - timeMs: fallback headline time if milestone math can't derive one
 *  - telemetry: [{ t, speed, rpm, load, throttle, coolant, intake }, ...]
 *  - filterKey: e.g. '0-100', '60-130', '1/4mi'
 *  - onClose: () => void
 */
export default function PerfRunDetailModal({ timestamp, timeMs, telemetry, filterKey, onClose }) {
  const runData = telemetry || [];

  return (
    <div className="fixed inset-0 z-[130] bg-black/80 backdrop-blur-md flex items-end md:items-center justify-center animate-in fade-in p-4 pt-safe">
      <div className="bg-[#0b0c10] w-full max-w-2xl rounded-3xl border border-gray-800 shadow-2xl h-[85dvh] flex flex-col animate-in zoom-in-95 overflow-hidden">
        <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318]">
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
              Деталі Заміру Динаміки
            </h2>
            <div className="text-[10px] text-gray-500 mt-1">{new Date(timestamp).toLocaleString('uk-UA')}</div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-white">
                {formatPerfTime(getMilestoneTime(runData, filterKey) || timeMs)}
              </span>
              <span className="text-sm font-bold text-gray-400 tabular-nums">
                ({Math.round(getMilestoneDistance(runData, filterKey))} м)
              </span>
            </div>
            <button onClick={onClose} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors flex-shrink-0">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>
        </div>
        <div className="flex-1 p-5 overflow-y-auto overscroll-contain space-y-6">
          {runData.length === 0 ? (
            <div className="text-gray-500 text-sm">Немає збережених даних телеметрії.</div>
          ) : (() => {
            const maxRpm = Math.max(...runData.map(d => d.rpm));
            const maxLoad = Math.max(...runData.map(d => d.load));
            const maxThrottle = Math.max(...runData.map(d => d.throttle));
            const startTemp = runData[0].coolant;

            let m50 = false, m100 = false, m150 = false, m200 = false;

            return (
              <>
                <DragyStyleChart runData={runData} />

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                    <div className="text-[9px] text-gray-500 uppercase">Макс Оберти</div>
                    <div className="text-lg font-bold text-purple-400">{maxRpm} rpm</div>
                  </div>
                  <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                    <div className="text-[9px] text-gray-500 uppercase">Пік Навантаження</div>
                    <div className="text-lg font-bold text-orange-400">{maxLoad}%</div>
                  </div>
                  <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                    <div className="text-[9px] text-gray-500 uppercase">Макс Дросель</div>
                    <div className="text-lg font-bold text-blue-400">{maxThrottle}%</div>
                  </div>
                  <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                    <div className="text-[9px] text-gray-500 uppercase">Темп на старті</div>
                    <div className="text-lg font-bold text-green-400">{startTemp}°C</div>
                  </div>
                </div>

                <div>
                  <h3 className="text-[10px] text-gray-500 font-bold uppercase mb-3 border-b border-gray-800 pb-2">Покрокова телеметрія</h3>
                  <div className="space-y-1">
                    <div className="flex text-[9px] text-gray-600 font-bold px-2 uppercase">
                      <div className="w-12">Час</div>
                      <div className="w-16">Швидк.</div>
                      <div className="w-16">Оберти</div>
                      <div className="w-16">Навант.</div>
                      <div className="flex-1">Дросель</div>
                    </div>
                    {runData.map((pt, i) => {
                      const show50 = !m50 && pt.speed >= 50 && (m50 = true);
                      const show100 = !m100 && pt.speed >= 100 && (m100 = true);
                      const show150 = !m150 && pt.speed >= 150 && (m150 = true);
                      const show200 = !m200 && pt.speed >= 200 && (m200 = true);

                      return (
                        <React.Fragment key={i}>
                          {show50 && <div className="text-center text-[10px] text-green-400 font-bold bg-green-900/20 py-1 my-1 rounded border border-green-800/30">--- 50 км/год ({formatPerfTime(pt.t)}) ---</div>}
                          {show100 && <div className="text-center text-[10px] text-blue-400 font-bold bg-blue-900/20 py-1 my-1 rounded border border-blue-800/30">--- 100 км/год ({formatPerfTime(pt.t)}) ---</div>}
                          {show150 && <div className="text-center text-[10px] text-purple-400 font-bold bg-purple-900/20 py-1 my-1 rounded border border-purple-800/30">--- 150 км/год ({formatPerfTime(pt.t)}) ---</div>}
                          {show200 && <div className="text-center text-[10px] text-red-400 font-bold bg-red-900/20 py-1 my-1 rounded border border-red-800/30">--- 200 км/год ({formatPerfTime(pt.t)}) ---</div>}

                          <div className="flex text-xs font-mono px-2 py-1.5 bg-[#111318] rounded-lg border border-gray-800/50 hover:border-gray-700">
                            <div className="w-12 text-gray-500">{(pt.t/1000).toFixed(1)}s</div>
                            <div className="w-16 text-white font-bold">{pt.speed}</div>
                            <div className="w-16 text-purple-400">{pt.rpm}</div>
                            <div className="w-16 text-orange-400">{pt.load}%</div>
                            <div className="flex-1 text-blue-400">{pt.throttle}%</div>
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
