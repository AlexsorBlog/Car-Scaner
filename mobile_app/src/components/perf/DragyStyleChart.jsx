import React, { useRef, useState, useMemo } from 'react';

/**
 * components/perf/DragyStyleChart.jsx
 * Extracted verbatim from DashboardPage.jsx so the exact same rich
 * speed/accel/distance chart (pinch-zoom, crosshair, milestone markers,
 * split-times footer) renders both for your own runs and for anyone's
 * runs viewed via the public leaderboard profile.
 *
 * runData: [{ t, speed, rpm?, load?, throttle?, coolant?, intake? }, ...]
 */
export const DragyStyleChart = ({ runData }) => {
  const containerRef     = useRef(null)
  const [hoverIndex,  setHoverIndex]  = useState(null)
  const [zoomScale,   setZoomScale]   = useState(1)
  const [panOffset,   setPanOffset]   = useState(0)
  const [activeTab,   setActiveTab]   = useState('all') // 'all' | 'speed' | 'accel' | 'dist'
  const initialPinchDist = useRef(null)
  const initialScale     = useRef(1)
  const initialPan       = useRef(0)
  const initialCenterPct = useRef(0)
  const singleTouchStartX = useRef(null)
  const singleTouchStartPan = useRef(0)

  // ── Physics enrichment ──────────────────────────────────────────────────────
  const enrichedData = useMemo(() => {
    if (!runData || runData.length === 0) return []
    let dist = 0
    const raw = runData.map((pt, i) => {
      if (i === 0) return { ...pt, dist: 0, accelG: 0 }
      const prev  = runData[i - 1]
      const dtSec = (pt.t - prev.t) / 1000
      const v1Ms  = prev.speed / 3.6
      const v2Ms  = pt.speed  / 3.6
      const a     = dtSec > 0 ? (v2Ms - v1Ms) / dtSec : 0
      dist += v1Ms * dtSec + 0.5 * a * dtSec * dtSec
      return { ...pt, dist, accelG: a / 9.81 }
    })
    // 3-point moving average smoothing on G values
    return raw.map((pt, i, arr) => {
      if (i === 0 || i === arr.length - 1) return pt
      return { ...pt, accelG: (arr[i-1].accelG + pt.accelG + arr[i+1].accelG) / 3 }
    })
  }, [runData])

  if (enrichedData.length === 0) return null

  const maxTime  = enrichedData[enrichedData.length - 1].t || 1
  const maxSpeed = Math.max(...enrichedData.map(d => d.speed), 100)
  const maxDist  = Math.max(...enrichedData.map(d => d.dist), 10)
  const maxG = 1.5, minG = -0.5

  // ── Milestone markers ───────────────────────────────────────────────────────
  const milestones = [50, 100, 150, 200].map(spd => {
    const pt = enrichedData.find(d => d.speed >= spd)
    if (!pt) return null
    return { spd, xPct: (pt.t / maxTime) * 100, elapsedMs: pt.t }
  }).filter(Boolean)

  // ── SVG point generators ────────────────────────────────────────────────────
  const speedPts = enrichedData.map(d =>
    `${(d.t/maxTime)*100},${100-(d.speed/maxSpeed)*100}`).join(' ')
  const accelPts = enrichedData.map(d => {
    const g = Math.max(minG, Math.min(maxG, d.accelG))
    return `${(d.t/maxTime)*100},${100-((g-minG)/(maxG-minG))*100}`
  }).join(' ')
  const distPts = enrichedData.map(d =>
    `${(d.t/maxTime)*100},${100-(d.dist/maxDist)*100}`).join(' ')
  // Speed fill polygon
  const speedFill = `0,100 ${speedPts} 100,100`

  // ── Crosshair lookup ────────────────────────────────────────────────────────
  const findClosest = (xPos, rect) => {
    const xPct       = Math.max(0, Math.min(1, (xPos - rect.left) / rect.width))
    const visibleXPct = (xPct / zoomScale) + (panOffset / 100)
    const targetTime  = visibleXPct * maxTime
    let best = 0, bestDiff = Infinity
    enrichedData.forEach((d, i) => {
      const diff = Math.abs(d.t - targetTime)
      if (diff < bestDiff) { bestDiff = diff; best = i }
    })
    return best
  }

  const handleMouseMove = (e) => {
    if (!containerRef.current) return
    setHoverIndex(findClosest(e.clientX, containerRef.current.getBoundingClientRect()))
  }

  // ── Touch: single-finger pan + two-finger pinch zoom ───────────────────────
  const handleTouchStart = (e) => {
    if (e.touches.length === 2 && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const t1 = e.touches[0], t2 = e.touches[1]
      initialPinchDist.current  = Math.hypot(t1.clientX-t2.clientX, t1.clientY-t2.clientY)
      initialScale.current      = zoomScale
      initialPan.current        = panOffset
      initialCenterPct.current  = ((t1.clientX+t2.clientX)/2 - rect.left) / rect.width
      singleTouchStartX.current = null
    } else if (e.touches.length === 1) {
      singleTouchStartX.current   = e.touches[0].clientX
      singleTouchStartPan.current = panOffset
    }
  }

  const handleTouchMove = (e) => {
    e.preventDefault()
    if (e.touches.length === 2 && initialPinchDist.current && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const t1 = e.touches[0], t2 = e.touches[1]
      const d  = Math.hypot(t1.clientX-t2.clientX, t1.clientY-t2.clientY)
      const ctr = ((t1.clientX+t2.clientX)/2 - rect.left) / rect.width
      const newScale = Math.max(1, Math.min(12, initialScale.current * (d / initialPinchDist.current)))
      let   newPan   = (initialCenterPct.current / initialScale.current + initialPan.current / 100 - ctr / newScale) * 100
      const maxPan   = ((newScale - 1) / newScale) * 100
      newPan = Math.max(0, Math.min(newPan, maxPan))
      setZoomScale(newScale)
      setPanOffset(newPan)
    } else if (e.touches.length === 1 && singleTouchStartX.current !== null) {
      if (e.touches[0].identifier !== undefined && initialPinchDist.current) return
      const dx       = e.touches[0].clientX - singleTouchStartX.current
      const pxToUnit = 100 / (containerRef.current?.clientWidth || 375)
      const dPan     = -dx * pxToUnit / zoomScale
      const maxPan   = ((zoomScale - 1) / zoomScale) * 100
      setPanOffset(Math.max(0, Math.min(singleTouchStartPan.current + dPan, maxPan)))
      // Also update crosshair
      if (containerRef.current)
        setHoverIndex(findClosest(e.touches[0].clientX, containerRef.current.getBoundingClientRect()))
    }
  }

  const handleTouchEnd = (e) => {
    if (e.touches.length < 2) initialPinchDist.current = null
    if (e.touches.length === 0) { singleTouchStartX.current = null; setHoverIndex(null) }
  }

  const resetZoom = () => { setZoomScale(1); setPanOffset(0) }

  const activePoint = hoverIndex !== null ? enrichedData[hoverIndex] : null

  // ── Tab visibility ──────────────────────────────────────────────────────────
  const showSpeed = activeTab === 'all' || activeTab === 'speed'
  const showAccel = activeTab === 'all' || activeTab === 'accel'
  const showDist  = activeTab === 'all' || activeTab === 'dist'

  return (
    <div className="rounded-2xl border border-gray-800/80 overflow-hidden mb-2" style={{ background: 'linear-gradient(180deg,#0d0f14 0%,#0a0c10 100%)' }}>

      {/* ── Header row ── */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-gray-800/60">
        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Run Graph</span>
        <div className="flex items-center gap-1.5">
          {zoomScale > 1 && (
            <button onClick={resetZoom}
              className="text-[9px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
              RESET
            </button>
          )}
          <span className="text-[9px] font-bold text-gray-600 font-mono">{zoomScale.toFixed(1)}x</span>
          <button onClick={() => { const ns=Math.max(1,zoomScale-0.5); const mp=((ns-1)/ns)*100; setZoomScale(ns); setPanOffset(p=>Math.min(p,mp)) }}
            className="w-6 h-6 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white text-xs flex items-center justify-center font-bold">−</button>
          <button onClick={() => setZoomScale(ns=>Math.min(12,ns+0.5))}
            className="w-6 h-6 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white text-xs flex items-center justify-center font-bold">+</button>
        </div>
      </div>

      {/* ── Tab selector ── */}
      <div className="flex gap-1 px-4 pt-2">
        {[
          { id:'all',   label:'Все',       color:'text-gray-300' },
          { id:'speed', label:'Швидк.',    color:'text-blue-400' },
          { id:'accel', label:'Приск.',    color:'text-orange-400' },
          { id:'dist',  label:'Дист.',     color:'text-green-400' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-2.5 py-1 rounded-full text-[9px] font-bold transition-all
              ${activeTab===tab.id
                ? `${tab.color} bg-white/5 border border-white/10`
                : 'text-gray-600 hover:text-gray-400'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Chart area ── */}
      <div className="relative px-4 pb-1 pt-2">
        {/* Y-axis labels left (speed) */}
        <div className="absolute left-1 top-2 flex flex-col justify-between pointer-events-none" style={{ height: 180 }}>
          {[maxSpeed, Math.round(maxSpeed*0.75), Math.round(maxSpeed*0.5), Math.round(maxSpeed*0.25), 0].map((v,i) => (
            <span key={i} className="text-[8px] text-blue-500/70 font-bold font-mono leading-none">{v}</span>
          ))}
        </div>

        {/* Y-axis labels right (G) */}
        <div className="absolute right-1 top-2 flex flex-col justify-between pointer-events-none" style={{ height: 180 }}>
          {[maxG, 0.75, 0, -0.25, minG].map((v,i) => (
            <span key={i} className="text-[8px] text-orange-500/70 font-bold font-mono leading-none">{v>0?'+':''}{v}g</span>
          ))}
        </div>

        <div
          ref={containerRef}
          className="relative mx-5 overflow-hidden rounded-lg"
          style={{ height: 180, touchAction: 'none', cursor: 'crosshair',
            background: 'linear-gradient(180deg,rgba(59,130,246,0.03) 0%,rgba(0,0,0,0) 100%)' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <svg
            viewBox="0 0 100 100"
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="none"
            style={{ transform: `translateX(-${panOffset}%) scaleX(${zoomScale})`, transformOrigin: '0 0' }}
          >
            <defs>
              <linearGradient id="speed-fill-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.25"/>
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02"/>
              </linearGradient>
              <linearGradient id="speed-line-grad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%"   stopColor="#60a5fa"/>
                <stop offset="60%"  stopColor="#3b82f6"/>
                <stop offset="100%" stopColor="#ef4444"/>
              </linearGradient>
            </defs>

            {/* Horizontal grid */}
            {[0,25,50,75,100].map(y => (
              <line key={y} x1="0" y1={y} x2="100" y2={y}
                stroke={y===50?'#374151':'#1f2937'} strokeWidth="0.4"
                strokeDasharray={y===50?'':'1.5,1.5'} vectorEffect="non-scaling-stroke"/>
            ))}
            {/* Vertical grid */}
            {[20,40,60,80].map(x => (
              <line key={x} x1={x} y1="0" x2={x} y2="100"
                stroke="#1a1f2e" strokeWidth="0.4" vectorEffect="non-scaling-stroke"/>
            ))}

            {/* Milestone vertical lines */}
            {milestones.map(m => (
              <line key={m.spd}
                x1={m.xPct} y1="0" x2={m.xPct} y2="100"
                stroke="#374151" strokeWidth="0.6"
                strokeDasharray="1,2" vectorEffect="non-scaling-stroke"/>
            ))}

            {/* Distance line */}
            {showDist && (
              <polyline fill="none" stroke="#22c55e" strokeWidth="1.2"
                strokeLinecap="round" strokeLinejoin="round"
                points={distPts} opacity="0.55" vectorEffect="non-scaling-stroke"/>
            )}

            {/* Acceleration line */}
            {showAccel && (
              <polyline fill="none" stroke="#f97316" strokeWidth="1"
                strokeLinecap="round" strokeLinejoin="round"
                points={accelPts} opacity="0.75" vectorEffect="non-scaling-stroke"/>
            )}

            {/* Speed fill */}
            {showSpeed && (
              <polygon fill="url(#speed-fill-grad)" points={speedFill} vectorEffect="non-scaling-stroke"/>
            )}
            {/* Speed line */}
            {showSpeed && (
              <polyline fill="none" stroke="url(#speed-line-grad)" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
                points={speedPts} vectorEffect="non-scaling-stroke"/>
            )}

            {/* Crosshair */}
            {activePoint && (
              <line
                x1={(activePoint.t/maxTime)*100} y1="0"
                x2={(activePoint.t/maxTime)*100} y2="100"
                stroke="rgba(255,255,255,0.3)" strokeWidth="0.5"
                strokeDasharray="2,1.5" vectorEffect="non-scaling-stroke"/>
            )}

            {/* Crosshair dot on speed line */}
            {activePoint && showSpeed && (
              <circle
                cx={(activePoint.t/maxTime)*100}
                cy={100-(activePoint.speed/maxSpeed)*100}
                r="1.2" fill="#60a5fa" stroke="#fff" strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"/>
            )}
          </svg>

          {/* Milestone labels — HTML overlay so they don't scale with SVG */}
          {milestones.map(m => {
            const visX = (m.xPct - panOffset) * zoomScale
            if (visX < 0 || visX > 100) return null
            return (
              <div key={m.spd}
                className="absolute top-1 flex flex-col items-center pointer-events-none"
                style={{ left:`${visX}%`, transform:'translateX(-50%)' }}>
                <span className="text-[8px] font-black text-blue-300 bg-[#0a0c10]/80 px-1 rounded leading-tight">{m.spd}</span>
                <span className="text-[7px] text-gray-500 font-mono leading-tight">{(m.elapsedMs/1000).toFixed(2)}s</span>
              </div>
            )
          })}

          {/* Tooltip */}
          {activePoint && (
            <div
              className="absolute pointer-events-none z-20"
              style={{
                top: 6,
                left: `${Math.max(5,Math.min(75,((activePoint.t/maxTime)*100*zoomScale)-(panOffset*zoomScale)))}%`,
                transform: `translateX(${((activePoint.t/maxTime)*zoomScale-(panOffset/100)) > 0.5 ? '-105%' : '8%'})`,
              }}
            >
              <div className="bg-[#111318]/95 border border-gray-700/80 rounded-xl px-3 py-2 shadow-2xl backdrop-blur-sm"
                style={{ minWidth: 110 }}>
                <div className="text-[10px] font-black text-white font-mono mb-1.5 border-b border-gray-700/60 pb-1">
                  {(activePoint.t/1000).toFixed(2)} с
                </div>
                <div className="space-y-0.5">
                  <div className="flex justify-between gap-3 text-[9px]">
                    <span className="text-gray-500">Швидк.</span>
                    <span className="text-blue-400 font-bold font-mono">{Math.round(activePoint.speed)} <span className="text-gray-600">км/год</span></span>
                  </div>
                  <div className="flex justify-between gap-3 text-[9px]">
                    <span className="text-gray-500">Приск.</span>
                    <span className={`font-bold font-mono ${activePoint.accelG>0?'text-orange-400':'text-cyan-400'}`}>{activePoint.accelG>=0?'+':''}{activePoint.accelG.toFixed(2)} <span className="text-gray-600">G</span></span>
                  </div>
                  <div className="flex justify-between gap-3 text-[9px]">
                    <span className="text-gray-500">Дист.</span>
                    <span className="text-green-400 font-bold font-mono">{Math.round(activePoint.dist)} <span className="text-gray-600">м</span></span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Time axis */}
        <div className="flex justify-between text-[8px] text-gray-600 font-mono mx-5 mt-1">
          <span>0.0с</span>
          <span>{(maxTime/2000).toFixed(1)}с</span>
          <span>{(maxTime/1000).toFixed(1)}с</span>
        </div>
      </div>

      {/* ── Split times footer ── */}
      {milestones.length > 0 && (
        <div className="px-4 pb-3 pt-1">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${milestones.length}, 1fr)` }}>
            {milestones.map((m, i) => {
              const prev = i === 0 ? null : milestones[i-1]
              const splitMs = prev ? m.elapsedMs - prev.elapsedMs : m.elapsedMs
              return (
                <div key={m.spd} className="bg-gray-900/50 border border-gray-800/60 rounded-xl p-2 text-center">
                  <div className="text-[8px] text-gray-500 font-bold">
                    {prev ? `${prev.spd}→${m.spd}` : `0→${m.spd}`}
                  </div>
                  <div className="text-sm font-black text-white font-mono leading-tight">
                    {(m.elapsedMs/1000).toFixed(2)}s
                  </div>
                  {prev && (
                    <div className="text-[8px] text-blue-400/70 font-mono">+{(splitMs/1000).toFixed(2)}s</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Legend ── */}
      <div className="flex gap-3 px-4 pb-3 border-t border-gray-800/40 pt-2">
        <div className="flex items-center gap-1">
          <div className="w-4 h-0.5 rounded-full bg-gradient-to-r from-blue-400 to-red-400"/>
          <span className="text-[9px] text-gray-500">Швидк.</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-0.5 rounded-full bg-orange-400 opacity-75"/>
          <span className="text-[9px] text-gray-500">Приск.</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-0.5 rounded-full bg-green-400 opacity-55"/>
          <span className="text-[9px] text-gray-500">Дист.</span>
        </div>
        <div className="ml-auto text-[8px] text-gray-700 font-mono">
          {enrichedData.length} pts · {(maxTime/1000).toFixed(1)}s
        </div>
      </div>
    </div>
  )
}
