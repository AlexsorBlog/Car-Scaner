/**
 * services/api.js — CarSense server API client
 *
 * Usage:
 *   import { api } from './services/api.js';
 *   const { token, user } = await api.register({ phone, password, name });
 *   await api.savePerfRecord({ filter_key: '0-100', time_ms: 5200, telemetry });
 *   const board = await api.leaderboard('0-100', 'BMW');
 */

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Token helpers ─────────────────────────────────────────────────────────────

const getToken = () => localStorage.getItem('obd_token');

async function request(method, path, body = null, isFormData = false) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body
      ? (isFormData ? body : JSON.stringify(body))
      : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const api = {
  // Register: phone + password + name + optional car info
  async register(payload) {
    const data = await request('POST', '/api/auth/register', payload);
    if (data.token) localStorage.setItem('obd_token', data.token);
    return data;
  },

  // Login: phone + password
  async login(phone, password) {
    const data = await request('POST', '/api/auth/login', { phone, password });
    if (data.token) localStorage.setItem('obd_token', data.token);
    return data;
  },

  logout() {
    localStorage.removeItem('obd_token');
  },

  async getProfile() {
    return request('GET', '/api/auth/profile');
  },

  async updateProfile(payload) {
    return request('PUT', '/api/auth/profile', payload);
  },

  // Requires the current password even though we already hold a token — a
  // borrowed/stolen phone shouldn't be enough to lock the owner out.
  async changePassword({ currentPassword, newPassword }) {
    return request('PUT', '/api/auth/password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
  },

  async updateAvatar(imageFile) {
    const fd = new FormData();
    fd.append('avatar', imageFile);
    return request('PUT', '/api/auth/avatar', fd, true);
  },

  // ── Performance ─────────────────────────────────────────────────────────────

  async savePerfRecord({ filter_key, time_ms, distance_m = 0, telemetry = [] }) {
    return request('POST', '/api/perf', { filter_key, time_ms, distance_m, telemetry });
  },

  async getMyPerfRecords() {
    return request('GET', '/api/perf/mine');
  },

  async leaderboard(filter, brand = '', offset = 0, limit = 20) {
    const params = new URLSearchParams({ filter, offset, limit });
    if (brand) params.set('brand', brand);
    return request('GET', `/api/perf/leaderboard?${params}`);
  },

  async getPublicProfile(userId) {
    return request('GET', `/api/perf/user/${userId}`);
  },

  // ── Daily summary ────────────────────────────────────────────────────────────

  async saveSummary(payload) {
    return request('POST', '/api/summary', payload);
  },

  async getSummaries() {
    return request('GET', '/api/summary');
  },

  // ── Chat ─────────────────────────────────────────────────────────────────────

  async sendMessage({ message, chat_type = 'main', imageFile = null }) {
    // The backend always expects multipart/form-data for this endpoint
    // (message/chat_type/image are all Form fields, even without an image) —
    // sending JSON here would silently fail to parse server-side.
    const fd = new FormData();
    fd.append('message', message || '');
    fd.append('chat_type', chat_type);
    if (imageFile) fd.append('image', imageFile);
    return request('POST', '/api/chat', fd, true);
  },

  async getChatHistory(chat_type = 'main') {
    return request('GET', `/api/chat?type=${chat_type}`);
  },

  async clearChat(chat_type = 'main') {
    return request('DELETE', `/api/chat?type=${chat_type}`);
  },

  // ── Health ───────────────────────────────────────────────────────────────────

  async health() {
    return request('GET', '/api/health');
  },
};
