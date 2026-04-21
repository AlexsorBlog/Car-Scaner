import React from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';

export default function AppLayout() {
  return (
    <div className="bg-[#050505] text-white min-h-screen font-sans overflow-x-hidden selection:bg-blue-500/30">
      <main className="pb-24 min-h-screen">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}