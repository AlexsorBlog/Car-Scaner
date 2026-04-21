import React from 'react';

export default function Speedometer({ speed }) {
  return (
    <div className="flex justify-center items-center mb-10">
      <div className="relative w-56 h-56 rounded-full border-[6px] border-gray-800 flex flex-col justify-center items-center shadow-[0_0_30px_rgba(59,130,246,0.15)]">
        <svg className="absolute inset-0 w-full h-full transform -rotate-90">
           <circle 
             cx="106" cy="106" r="100" 
             stroke="#3b82f6" 
             strokeWidth="6" 
             fill="none" 
             strokeDasharray="628" 
             strokeDashoffset="200" 
             className="transition-all duration-300 ease-out"
           />
        </svg>
        <span className="text-6xl font-black tracking-tighter">{speed}</span>
        <span className="text-xs text-gray-400 font-bold tracking-wider mt-1">КМ/ГОД</span>
      </div>
    </div>
  );
}