/**
 * App.jsx — Root router
 *
 * Changes vs original:
 *  - Wrapped with <TelemetryProvider> so ALL pages share one OBD polling loop
 *  - <ConfirmModal /> mounted at root so it overlays everything
 *  - <ToastContainer /> mounted at root for global toast notifications
 *  - Stale inline code-guide comments removed
 *  - BluetoothTest import kept — it's the testing page at /test
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { TelemetryProvider } from './context/TelemetryContext.jsx';
import ConfirmModal           from './components/ui/ConfirmModal.jsx';
import { ToastContainer }     from './components/ui/Toast.jsx';

import AppLayout       from './components/layout/AppLayout.jsx';
import DashboardPage   from './pages/DashboardPage.jsx';
import DiagnosticsPage from './pages/DiagnosticsPage.jsx';
import ScanPage        from './pages/ScanPage.jsx';
import ServicesPage    from './pages/ServicesPage.jsx';
import ProfilePage     from './pages/ProfilePage.jsx';
import LoginPage       from './pages/LoginPage.jsx';
import BluetoothTest   from './pages/BluetoothTest.jsx';

// ── Auth guard ────────────────────────────────────────────────────────────────

const PrivateRoute = ({ children }) => {
  const token = localStorage.getItem('obd_token');
  return token ? children : <Navigate to="/login" replace />;
};

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

        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected routes */}
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

      </TelemetryProvider>
    </BrowserRouter>
  );
}

export default App;