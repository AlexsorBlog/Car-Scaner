import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import DashboardPage from './pages/DashboardPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import ScanPage from './pages/ScanPage';
import ServicesPage from './pages/ServicesPage';
import ProfilePage from './pages/ProfilePage';
import LoginPage from './pages/LoginPage'; // Наша нова сторінка
// Додайте імпорт зверху
import BluetoothTest from './pages/BluetoothTest';



// Компонент-запобіжник: якщо немає токена, кидає на сторінку логіну
const PrivateRoute = ({ children }) => {
  const token = localStorage.getItem('obd_token');
  return token ? children : <Navigate to="/login" replace />;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Публічний маршрут */}
        <Route path="/login" element={<LoginPage />} />

        {/* Захищені маршрути (тільки для авторизованих) */}
        <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="diagnostics" element={<DiagnosticsPage />} />
          <Route path="scan" element={<ScanPage />} />
          <Route path="services" element={<ServicesPage />} />
          <Route path="profile" element={<ProfilePage />} />
          {/* // Додайте Route всередині <Routes> (можна перед закриваючим </Route> для AppLayout) */}
          <Route path="test" element={<BluetoothTest />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;