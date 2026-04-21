import React from 'react';

export default function Header({ status = "Disconnected", isConnected = false }) {
  return (
    <header className="flex justify-between items-center mb-8">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-blue-500 animate-pulse' : 'bg-red-500'}`}></div>
        <span className={`text-xs font-semibold tracking-widest uppercase ${isConnected ? 'text-blue-500' : 'text-red-500'}`}>
          OBD-II {status}
        </span>
      </div>
      <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center">
        <span className="text-xs">👤</span>
      </div>
    </header>
  );
}