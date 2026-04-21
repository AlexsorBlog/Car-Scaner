import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function LoginPage() {
  const [phone, setPhone] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // Робимо запит до нашого Node.js сервера
      const response = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });

      const data = await response.json();

      if (response.ok) {
        // Зберігаємо токен у пам'ять телефону (LocalStorage)
        localStorage.setItem('obd_token', data.token);
        localStorage.setItem('obd_user', JSON.stringify(data.user));
        
        // Переходимо на Дашборд
        navigate('/dashboard');
      } else {
        setError(data.error || 'Помилка авторизації');
      }
    } catch (err) {
      setError('Не вдалося з\'єднатися з сервером');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm bg-[#111318] rounded-3xl p-8 shadow-2xl border border-gray-800">
        
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center shadow-[0_0_20px_rgba(37,99,235,0.4)]">
             <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          </div>
        </div>

        <h1 className="text-2xl font-black text-center mb-2 text-white tracking-wide">ETHER_LINK</h1>
        <p className="text-gray-500 text-center mb-8 text-xs font-bold tracking-widest uppercase">Система телеметрії</p>
        
        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div>
            <label className="text-[10px] text-gray-500 font-bold tracking-widest mb-1 block">НОМЕР ТЕЛЕФОНУ</label>
            <input 
              type="tel" 
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+380 XX XXX XX XX" 
              required
              className="w-full bg-gray-900/50 border border-gray-700 rounded-xl p-4 text-white focus:outline-none focus:border-blue-500 transition-colors placeholder-gray-600"
            />
          </div>

          {error && <p className="text-red-500 text-xs font-bold text-center">{error}</p>}
          
          <button 
            type="submit"
            disabled={isLoading}
            className="w-full mt-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white font-bold py-4 rounded-xl transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)] flex justify-center items-center"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              "УВІЙТИ"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}