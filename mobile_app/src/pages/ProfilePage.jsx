import React, { useState, useEffect } from 'react';
import { useTelemetry } from '../context/TelemetryContext.jsx';
import { getRawLogs } from '../services/db.js';
import { toast } from '../components/ui/Toast.jsx';

export default function ProfilePage() {
  const { user, isLoading, refreshProfile } = useTelemetry();
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  
  // Стан для режиму редагування
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', make: '', model: '', vin: '' });

  // Коли дані юзера завантажились, заповнюємо форму
  useEffect(() => {
    if (user) {
      setFormData({
        name: user.name || '',
        email: user.email || '',
        make: user.make || '',
        model: user.model || '',
        vin: user.vin || ''
      });
    }
  }, [user]);

  const handleLogout = () => {
    localStorage.removeItem('obd_token');
    window.location.reload();
  };

  const handleSave = async () => {
    setIsSaving(true);
    const token = localStorage.getItem('obd_token');
    
    try {
      const response = await fetch('http://localhost:3000/api/user/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        await refreshProfile(); // Оновлюємо дані на екрані
        setIsEditing(false);    // Виходимо з режиму редагування
      }
    } catch (error) {
      console.error("Помилка збереження", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  // Експорт сирих логів OBD
  const exportDiagnosticLogs = async () => {
    try {
      const logs = await getRawLogs();
      if (!logs || logs.length === 0) {
        toast.info('Логи порожні. Спочатку підключіться до авто.');
        return;
      }
      
      const logText = logs.map(l => {
        const time = new Date(l.timestamp).toLocaleTimeString('uk-UA', { hour12: false });
        return `[${time}] [${l.type}] CMD: ${l.command} | RES: ${l.response} ${l.isError ? '(ERROR)' : ''}`;
      }).join('\n');

      await navigator.clipboard.writeText(logText);
      toast.success('Логи скопійовано! Тепер ви можете надіслати їх у Telegram.');
    } catch (err) {
      console.error("Помилка експорту логів", err);
      toast.error('Не вдалося експортувати логи.');
    }
  };

  if (isLoading) {
    return <div className="min-h-screen bg-[#050505] flex justify-center items-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;
  }

  return (
    <div className="p-5 flex flex-col gap-6 animate-in slide-in-from-bottom-4 duration-500 pt-10 pb-24">
      
      {/* Шапка профілю з кнопкою редагування */}
      <div className="flex flex-col items-center relative">
        <button 
          onClick={() => isEditing ? handleSave() : setIsEditing(true)}
          className="absolute top-0 right-0 text-sm font-bold text-blue-500 bg-blue-500/10 px-3 py-1.5 rounded-full hover:bg-blue-500/20 transition-colors"
          disabled={isSaving}
        >
          {isSaving ? "Збереження..." : (isEditing ? "Зберегти" : "Редагувати")}
        </button>

        <div className="w-24 h-24 rounded-full border-4 border-gray-800 bg-gradient-to-tr from-gray-700 to-gray-600 flex items-center justify-center text-3xl shadow-xl">
          👩🏻
        </div>
        
        {isEditing ? (
          <div className="flex flex-col items-center mt-4 w-full px-8 gap-2">
            <input type="text" name="name" value={formData.name} onChange={handleChange} className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-center text-white focus:outline-none focus:border-blue-500" placeholder="Ваше ім'я" />
            <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-center text-gray-400 text-sm focus:outline-none focus:border-blue-500" placeholder="Email" />
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold mt-4">{user.name}</h1>
            <p className="text-sm text-gray-500">{user.email || 'Email не вказано'}</p>
          </>
        )}
      </div>

      {/* Telegram */}
      <div className="bg-gradient-to-br from-[#111318] to-[#0a0f1c] rounded-2xl p-5 border border-blue-900/30">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="font-bold text-white">Синхронізація з Telegram</h3>
        </div>
        <button className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl transition-all">
          ПІДКЛЮЧИТИ БОТА
        </button>
      </div>

      {/* Конфігурація Авто */}
      <div>
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">КОНФІГУРАЦІЯ АВТО</h3>
        <div className="bg-[#111318] rounded-2xl border border-gray-800 divide-y divide-gray-800 overflow-hidden">
          <div className="p-4 flex flex-col gap-1">
            <div className="text-[10px] text-gray-500 font-bold">МАРКА ТА МОДЕЛЬ</div>
            {isEditing ? (
              <div className="flex gap-2">
                <input type="text" name="make" value={formData.make} onChange={handleChange} className="w-1/2 bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500" placeholder="Марка" />
                <input type="text" name="model" value={formData.model} onChange={handleChange} className="w-1/2 bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500" placeholder="Модель" />
              </div>
            ) : (
              <div className="text-sm font-bold text-white">{user.vehicle}</div>
            )}
          </div>
          <div className="p-4 flex flex-col gap-1">
            <div className="text-[10px] text-gray-500 font-bold">VIN НОМЕР</div>
            {isEditing ? (
              <input type="text" name="vin" value={formData.vin} onChange={handleChange} className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500 uppercase" placeholder="VIN код" />
            ) : (
              <div className="text-sm font-bold text-gray-300 font-mono tracking-widest">{user.vin}</div>
            )}
          </div>
        </div>
      </div>

      {/* Розробник / Діагностика */}
      <div>
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">СЛУЖБОВА ІНФОРМАЦІЯ</h3>
        <button 
          onClick={exportDiagnosticLogs} 
          className="w-full bg-[#111318] hover:bg-[#161922] border border-gray-800 text-gray-300 font-bold py-3.5 rounded-xl transition-all flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
          ЕКСПОРТУВАТИ ЛОГИ ЕБУ
        </button>
        <p className="text-[10px] text-gray-600 text-center mt-2 px-4">
          У разі виникнення помилок зчитайте лог і надішліть його розробнику для аналізу.
        </p>
      </div>

      {/* Вихід */}
      <button onClick={handleLogout} className="mt-2 w-full bg-red-900/20 hover:bg-red-900/40 border border-red-900/50 text-red-500 font-bold py-4 rounded-xl transition-all">
        ВИЙТИ З АКАУНТУ
      </button>
    </div>
  );
}