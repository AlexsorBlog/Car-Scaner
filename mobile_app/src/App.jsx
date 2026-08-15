/**
 * App.jsx — Root router
 *
 * Changes vs original:
 *  - Wrapped with <TelemetryProvider> so ALL pages share one OBD polling loop
 *  - <ConfirmModal /> mounted at root so it overlays everything
 *  - <ToastContainer /> mounted at root for global toast notifications
 *  - Stale inline code-guide comments removed
 *  - BluetoothTest import kept — it's the testing page at /test
 *  - All routes except LoginPage are React.lazy-loaded to keep the initial
 *    bundle small (Leaderboard/Chat/Scan pull in extra deps — camera, etc.)
 *  - Leaderboard/Chat are full-screen pages with their own exit button, so
 *    they sit outside AppLayout (no bottom nav over them)
 */

import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { TelemetryProvider } from './context/TelemetryContext.jsx';
import ConfirmModal           from './components/ui/ConfirmModal.jsx';
import { ToastContainer }     from './components/ui/Toast.jsx';

import AppLayout       from './components/layout/AppLayout.jsx';
import LoginPage       from './pages/LoginPage.jsx';

const DashboardPage    = lazy(() => import('./pages/DashboardPage.jsx'));
const DiagnosticsPage  = lazy(() => import('./pages/DiagnosticsPage.jsx'));
const ScanPage         = lazy(() => import('./pages/ScanPage.jsx'));
const ServicesPage     = lazy(() => import('./pages/ServicesPage.jsx'));
const ProfilePage      = lazy(() => import('./pages/ProfilePage.jsx'));
const LeaderboardPage  = lazy(() => import('./pages/LeaderboardPage.jsx'));
const PublicProfilePage = lazy(() => import('./pages/PublicProfilePage.jsx'));
const ChatPage         = lazy(() => import('./pages/ChatPage.jsx'));
const BluetoothTest    = lazy(() => import('./pages/BluetoothTest.jsx'));

// ── Auth guard ────────────────────────────────────────────────────────────────

const PrivateRoute = ({ children }) => {
  const token = localStorage.getItem('obd_token');
  return token ? children : <Navigate to="/login" replace />;
};

const RouteFallback = () => (
  <div className="min-h-screen bg-[#050505] flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
  </div>
);

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  return (
    <BrowserRouter>
      {/*
        TelemetryProvider MUST be inside BrowserRouter so it can use useNavigate().
        It wraps all routes so every page shares one single OBD state instance.
      */}
      <TelemetryProvider>

        {/* Global overlays — always mounted regardless of current route */}
        <ConfirmModal />
        <ToastContainer />

        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />

            {/* Full-screen pages — own header/exit button, no bottom nav */}
            <Route path="/leaderboard"           element={<PrivateRoute><LeaderboardPage /></PrivateRoute>} />
            <Route path="/leaderboard/user/:id"  element={<PrivateRoute><PublicProfilePage /></PrivateRoute>} />
            <Route path="/chat"                  element={<PrivateRoute><ChatPage /></PrivateRoute>} />

            {/* Protected tab routes */}
            <Route
              path="/"
              element={
                <PrivateRoute>
                  <AppLayout />
                </PrivateRoute>
              }
            >
              <Route index                element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard"    element={<DashboardPage />} />
              <Route path="diagnostics"  element={<DiagnosticsPage />} />
              <Route path="scan"         element={<ScanPage />} />
              <Route path="services"     element={<ServicesPage />} />
              <Route path="profile"      element={<ProfilePage />} />
              <Route path="test"         element={<BluetoothTest />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>

      </TelemetryProvider>
    </BrowserRouter>
  );
}

export default App;
