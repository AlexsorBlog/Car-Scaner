import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { useTelemetry } from '../context/TelemetryContext.jsx';
import { getRawLogs, clearRawLogs } from '../services/db.js';
import { api } from '../services/api.js';
import { compressImage } from '../utils/compressImage.js';
import { toast } from '../components/ui/Toast.jsx';
import carModels from '../data/carModels.json';

const CAR_BRANDS = Object.keys(carModels).sort((a, b) => a.localeCompare(b));

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, isLoading, refreshProfile, confirmDialog } = useTelemetry();
  const [alertsEnabled, setAlertsEnabled] = useState(true);

  // Стан для режиму редагування
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isClearingLogs, setIsClearingLogs] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', make: '', model: '', vin: '' });

  const modelsForBrand = (formData.make && carModels[formData.make]) || [];

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
    api.logout();
    window.location.reload();
  };

  const handleSave = async () => {
    setIsSaving(true);

    try {
      await api.updateProfile({
        name:      formData.name,
        email:     formData.email,
        car_brand: formData.make,
        car_model: formData.model,
        vin:       formData.vin,
      });
      await refreshProfile(); // Оновлюємо дані на екрані
      setIsEditing(false);    // Виходимо з режиму редагування
      toast.success('Профіль збережено');
    } catch (error) {
      console.error('Помилка збереження', error);
      toast.error(error.message || 'Не вдалося зберегти профіль');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleBrandChange = (e) => {
    // Changing brand invalidates whatever model was picked for the old one
    setFormData({ ...formData, make: e.target.value, model: '' });
  };

  const handleAvatarTap = async () => {
    if (isUploadingAvatar) return;
    setIsUploadingAvatar(true);
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Prompt,
        resultType: CameraResultType.Uri,
        quality: 90,
      });
      const rawRes   = await fetch(photo.webPath);
      const rawBlob  = await rawRes.blob();
      const compressed = await compressImage(rawBlob, { maxDimension: 512, quality: 0.8 });

      await api.updateAvatar(compressed);
      await refreshProfile();
      toast.success('Фото профілю оновлено');
    } catch (err) {
      if (!/cancel/i.test(err.message || '')) {
        toast.error(err.message || 'Не вдалося оновити фото профілю');
      }
    } finally {
      setIsUploadingAvatar(false);
    }
  };

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

  const handleClearLogs = async () => {
    const ok = await confirmDialog('Очистити журнал діагностики ЕБУ? Дію не можна відмінити.');
    if (!ok) return;
    setIsClearingLogs(true);
    try {
      await clearRawLogs();
      toast.success('Журнал очищено');
    } catch (err) {
      console.error('Помилка очищення логів', err);
      toast.error('Не вдалося очистити журнал');
    } finally {
      setIsClearingLogs(false);
    }
  };

  if (isLoading) {
    return <div className=" bg-[#050505] flex justify-center items-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;
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

        <button
          onClick={handleAvatarTap}
          disabled={isUploadingAvatar}
          className="relative w-24 h-24 rounded-full border-4 border-gray-800 bg-gradient-to-tr from-gray-700 to-gray-600 flex items-center justify-center text-3xl shadow-xl overflow-hidden disabled:opacity-70"
          aria-label="Змінити фото профілю"
        >
          {user.avatarBase64 ? (
            <img
              src={`data:${user.avatarMime || 'image/jpeg'};base64,${user.avatarBase64}`}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            '👤'
          )}

          {/* Always-visible edit badge — hover states don't apply on touch */}
          <div className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-blue-600 border-2 border-[#050505] flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          </div>

          {isUploadingAvatar && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </button>

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
                <select name="make" value={formData.make} onChange={handleBrandChange} className="w-1/2 bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500">
                  <option value="">Марка</option>
                  {formData.make && !carModels[formData.make] && <option value={formData.make}>{formData.make}</option>}
                  {CAR_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                <select name="model" value={formData.model} onChange={handleChange} disabled={!formData.make} className="w-1/2 bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50">
                  <option value="">Модель</option>
                  {formData.model && !modelsForBrand.includes(formData.model) && <option value={formData.model}>{formData.model}</option>}
                  {modelsForBrand.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            ) : (
              <div className="text-sm font-bold text-white">{user.vehicle}</div>
            )}
          </div>
          <div className="p-4 flex flex-col gap-1">
            <div className="text-[10px] text-gray-500 font-bold">VIN НОМЕР</div>
            {isEditing ? (
              <>
                <input type="text" name="vin" value={formData.vin} onChange={handleChange} className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500 uppercase" placeholder="VIN код" maxLength={17} />
                {!formData.vin && (
                  <p className="text-[10px] text-gray-600 mt-1">Можна залишити порожнім — визначиться автоматично при першому підключенні до авто.</p>
                )}
              </>
            ) : (
              user.vin
                ? <div className="text-sm font-bold text-gray-300 font-mono tracking-widest">{user.vin}</div>
                : <div className="text-xs text-gray-600">Ще не визначено — підключіться до авто</div>
            )}
          </div>
        </div>
      </div>

      {/* Розробник / Діагностика */}
      <div>
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">СЛУЖБОВА ІНФОРМАЦІЯ</h3>
        <div className="flex gap-2">
          <button
            onClick={exportDiagnosticLogs}
            className="flex-1 bg-[#111318] hover:bg-[#161922] border border-gray-800 text-gray-300 font-bold py-3.5 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
            КОПІЮВАТИ
          </button>
          <button
            onClick={handleClearLogs}
            disabled={isClearingLogs}
            className="w-14 bg-[#111318] hover:bg-red-950/40 border border-gray-800 hover:border-red-900/50 text-gray-400 hover:text-red-400 font-bold py-3.5 rounded-xl transition-all flex items-center justify-center disabled:opacity-50"
            aria-label="Очистити журнал"
          >
            {isClearingLogs ? (
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            )}
          </button>
        </div>
        <p className="text-[10px] text-gray-600 text-center mt-2 px-4">
          Журнал ЕБУ — сирі команди та відповіді OBD-II. «Копіювати» — скопіювати
          в буфер обміну (наприклад, для Telegram). «Очистити» — стерти журнал
          перед новою діагностикою.
        </p>
      </div>

      {/* Рейтинг + AI Асистент */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => navigate('/leaderboard')}
          className="bg-[#111318] hover:bg-[#161922] border border-gray-800 rounded-2xl p-4 flex flex-col items-start gap-2 transition-all"
        >
          <span className="text-2xl">🏆</span>
          <span className="text-xs font-bold text-white">Рейтинг</span>
          <span className="text-[10px] text-gray-500">Топ-100 гонщиків</span>
        </button>
        <button
          onClick={() => navigate('/chat')}
          className="bg-[#111318] hover:bg-[#161922] border border-gray-800 rounded-2xl p-4 flex flex-col items-start gap-2 transition-all"
        >
          <span className="text-2xl">💬</span>
          <span className="text-xs font-bold text-white">AI Асистент</span>
          <span className="text-[10px] text-gray-500">Питання про авто</span>
        </button>
      </div>

      {/* Вихід */}
      <button onClick={handleLogout} className="mt-2 w-full bg-red-900/20 hover:bg-red-900/40 border border-red-900/50 text-red-500 font-bold py-4 rounded-xl transition-all">
        ВИЙТИ З АКАУНТУ
      </button>
    </div>
  );
}