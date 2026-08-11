import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api.js';

const BRANDS = ['BMW','Mercedes','Toyota','Honda','Audi','Volkswagen',
                 'Ford','Hyundai','Kia','Nissan','Mazda','Subaru','Інша'];

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode,   setMode]   = useState('login'); // 'login' | 'register' | 'profile'
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  // Login form
  const [phone,    setPhone]    = useState('');
  const [password, setPassword] = useState('');

  // Register extra fields
  const [name,      setName]      = useState('');
  const [carBrand,  setCarBrand]  = useState('');
  const [carModel,  setCarModel]  = useState('');
  const [carYear,   setCarYear]   = useState('');
  const [vin,       setVin]       = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.login(phone, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Помилка входу');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (mode === 'register') { setMode('profile'); return; }
    // mode === 'profile' — submit
    setLoading(true); setError('');
    try {
      await api.register({
        phone, password, name,
        car_brand: carBrand,
        car_model: carModel,
        car_year:  carYear ? parseInt(carYear) : null,
        vin,
      });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Помилка реєстрації');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center p-6">
      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-3">
          <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
              d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
          </svg>
        </div>
        <h1 className="text-2xl font-black text-white">CarSense</h1>
        <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-0.5">OBD-II Diagnostics</p>
      </div>

      <div className="w-full max-w-sm">
        {/* Tab switcher */}
        {mode !== 'profile' && (
          <div className="flex bg-[#111318] rounded-2xl p-1 border border-gray-800 mb-6">
            <button onClick={() => { setMode('login'); setError(''); }}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all
                ${mode === 'login' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500'}`}>
              Вхід
            </button>
            <button onClick={() => { setMode('register'); setError(''); }}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all
                ${mode === 'register' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500'}`}>
              Реєстрація
            </button>
          </div>
        )}

        {error && (
          <div className="bg-red-950/40 border border-red-900/30 text-red-400 text-xs p-3 rounded-xl mb-4">
            {error}
          </div>
        )}

        <form onSubmit={mode === 'login' ? handleLogin : handleRegister}
          className="flex flex-col gap-4">

          {/* ── Step 1: phone + password ── */}
          {(mode === 'login' || mode === 'register') && (
            <>
              <div>
                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">
                  Номер телефону
                </label>
                <input
                  type="tel" required value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="+380XXXXXXXXX"
                  className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              <div>
                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">
                  Пароль
                </label>
                <input
                  type="password" required value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Мінімум 6 символів"
                  className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              {mode === 'register' && (
                <div>
                  <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">
                    Ваше ім'я
                  </label>
                  <input
                    type="text" required value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Ім'я"
                    className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              )}
            </>
          )}

          {/* ── Step 2: car info (register only) ── */}
          {mode === 'profile' && (
            <>
              <div className="text-center mb-2">
                <h2 className="text-lg font-black text-white">Дані автомобіля</h2>
                <p className="text-[10px] text-gray-500">Можна змінити пізніше в профілі</p>
              </div>

              <div>
                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">Марка</label>
                <select value={carBrand} onChange={e => setCarBrand(e.target.value)}
                  className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500">
                  <option value="">Оберіть марку</option>
                  {BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">Модель</label>
                <input type="text" value={carModel} onChange={e => setCarModel(e.target.value)}
                  placeholder="3 Series, Camry, Civic..."
                  className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500"/>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">Рік</label>
                  <input type="number" value={carYear} onChange={e => setCarYear(e.target.value)}
                    placeholder="2020" min="1990" max={new Date().getFullYear()}
                    className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500"/>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1.5 block">VIN (опціонально)</label>
                  <input type="text" value={vin} onChange={e => setVin(e.target.value.toUpperCase())}
                    placeholder="WVWZZZ..."
                    className="w-full bg-[#111318] border border-gray-800 text-white px-4 py-3 rounded-xl text-sm outline-none focus:border-blue-500 font-mono"/>
                </div>
              </div>
            </>
          )}

          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl text-sm transition-all shadow-[0_0_20px_rgba(37,99,235,0.3)] mt-2">
            {loading ? 'Завантаження...' : mode === 'login' ? 'УВІЙТИ' : mode === 'register' ? 'ДАЛІ →' : 'ЗАРЕЄСТРУВАТИСЬ'}
          </button>

          {mode === 'profile' && (
            <button type="button" onClick={() => setMode('register')}
              className="w-full text-gray-500 text-xs underline py-1">
              ← Назад
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
