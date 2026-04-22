/**
 * bleService.js — OBD-II transport layer
 *
 * Supports two transport modes, switchable at runtime:
 * EMULATOR  → WebSocket → tcp-bridge.js → Python ELM327 emulator (desktop dev)
 * NATIVE    → Web Bluetooth (Laptop) OR Capacitor BLE (Android/iOS)
 */

import { Capacitor } from '@capacitor/core';
import { BleClient, dataViewToText, textToDataView } from '@capacitor-community/bluetooth-le';

// ── Constants ────────────────────────────────────────────────────────────────

const OBD_SERVICE_UUIDS = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '000018f0-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];

const WS_URL            = 'ws://localhost:8765';
const CMD_TIMEOUT_MS    = 4000;   // per-command timeout
const CONNECT_TIMEOUT_MS = 10000; // timeout for connection process
const MAX_BUFFER_BYTES  = 4096;   // guard against runaway buffer

export const TRANSPORT = {
  EMULATOR: 'emulator',
  NATIVE:   'native',
};

class BLEScanner {
  constructor() {
    this._mode       = TRANSPORT.EMULATOR;
    this._platform   = Capacitor.getPlatform(); // 'web' | 'android' | 'ios'
    this._connected  = false;

    // WebSocket state
    this._ws         = null;

    // Capacitor Native BLE state
    this._deviceId   = null;
    this._serviceId  = null;
    this._writeCharId  = null;
    this._notifyCharId = null;

    // Web Bluetooth state (Laptop)
    this._webDevice = null;
    this._webCharacteristicWrite = null;
    this._webCharacteristicNotify = null;

    this._buffer         = '';
    this._pendingResolve = null;
    this._pendingReject  = null;
    this._cmdTimer       = null;

    this.onLog          = null;
    this.onDisconnected = null;
    
    // Bind handleIncoming to preserve 'this' context for Web Bluetooth events
    this._handleIncomingWeb = this._handleIncomingWeb.bind(this);
  }

  setMode(mode) {
    if (this._connected) {
      this._log('Cannot switch mode while connected — disconnect first', 'WARN');
      return;
    }
    this._mode = (mode === TRANSPORT.NATIVE) ? TRANSPORT.NATIVE : TRANSPORT.EMULATOR;
    this._log(`Transport mode → ${this._mode}`);
  }

  get mode()      { return this._mode; }
  get connected() { return this._connected; }

  async connect() {
    if (this._connected) {
      this._log('Already connected', 'WARN');
      return true;
    }

    if (this._mode === TRANSPORT.NATIVE) {
      // BRANCH: Phone (Capacitor) vs Laptop (Web Bluetooth)
      if (this._platform !== 'web') {
        return this._connectCapacitorBLE();
      } else {
        return this._connectWebBluetooth();
      }
    } else {
      return this._connectWebSocket();
    }
  }

  sendCommand(cmd) {
    if (!this._connected) return Promise.reject(new Error('Not connected'));
    
    if (this._mode === TRANSPORT.NATIVE) {
      return this._platform !== 'web' 
        ? this._sendCapacitorBLE(cmd) 
        : this._sendWebBluetooth(cmd);
    } else {
      return this._sendWebSocket(cmd);
    }
  }

  async disconnect() {
    this._connected = false;
    this._cancelPending('Disconnected by user');
    this._buffer = '';

    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }

    if (this._deviceId) {
      try { await BleClient.disconnect(this._deviceId); } catch (_) {}
      this._deviceId   = null;
      this._serviceId  = null;
      this._writeCharId  = null;
      this._notifyCharId = null;
    }
    
    if (this._webDevice && this._webDevice.gatt.connected) {
      try { this._webDevice.gatt.disconnect(); } catch (_) {}
      this._webDevice = null;
      this._webCharacteristicWrite = null;
      this._webCharacteristicNotify = null;
    }

    this._log('Disconnected');
  }

  // ── WebSocket (Emulator) ──────────────────────────────────────────────────

  _connectWebSocket() {
    return new Promise((resolve) => {
      this._log(`Connecting to bridge at ${WS_URL}…`);
      try { this._ws = new WebSocket(WS_URL); } 
      catch (err) {
        this._log(`WebSocket create failed: ${err.message}`, 'ERROR');
        return resolve(false);
      }

      const timeout = setTimeout(() => {
        this._log('Bridge connection timed out', 'ERROR');
        try { this._ws?.close(); } catch (_) {}
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      this._ws.onopen = () => {
        clearTimeout(timeout);
        this._connected = true;
        this._log('Connected to emulator bridge ✓');
        resolve(true);
      };

      this._ws.onerror = () => {
        clearTimeout(timeout);
        this._log('Bridge not reachable — is tcp-bridge.js running?', 'ERROR');
        resolve(false);
      };

      this._ws.onclose = () => {
        if (this._connected) {
          this._connected = false;
          this._cancelPending('WebSocket closed unexpectedly');
          this._log('Bridge connection lost', 'WARN');
          this.onDisconnected?.();
        }
      };

      this._ws.onmessage = async (event) => {
        try {
          const text = (event.data instanceof Blob) ? await event.data.text() : String(event.data);
          this._handleIncoming(text);
        } catch (err) { this._log(`WS parse error: ${err.message}`, 'ERROR'); }
      };
    });
  }

  _sendWebSocket(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return reject(new Error('WebSocket not open'));
      this._setupPending(cmd, resolve, reject);
      this._ws.send(cmd);
    });
  }

  // ── Capacitor BLE (Android / iOS) ─────────────────────────────────────────

  async _connectCapacitorBLE() {
    try {
      this._log('Initialising Capacitor Bluetooth…');
      await BleClient.initialize();
      this._log('Очікування вибору пристрою користувачем...');
      
      const device = await BleClient.requestDevice();
      this._deviceId = device.deviceId;
      this._log(`Connecting to ${device.name ?? device.deviceId}…`);

      await Promise.race([
        BleClient.connect(this._deviceId, () => {
          this._connected = false;
          this._cancelPending('BLE device disconnected');
          this._log('BLE device disconnected unexpectedly', 'WARN');
          this.onDisconnected?.();
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out')), CONNECT_TIMEOUT_MS))
      ]);

      const services = await BleClient.getServices(this._deviceId);
      for (const svc of services) {
        let hasWrite = false, hasNotify = false;
        for (const char of svc.characteristics) {
          const p = char.properties;
          if (p.write || p.writeWithoutResponse) { hasWrite = true; this._writeCharId = char.uuid; }
          if (p.notify || p.indicate) { hasNotify = true; this._notifyCharId = char.uuid; }
        }
        if (hasWrite && hasNotify) { this._serviceId = svc.uuid; break; }
      }

      if (!this._serviceId) {
        this._log('Ideal UART service not found, trying fallback...', 'WARN');
        if (services.length > 0 && services[0].characteristics.length > 0) {
           this._serviceId = services[0].uuid;
           this._writeCharId = services[0].characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse)?.uuid;
           this._notifyCharId = services[0].characteristics.find(c => c.properties.notify || c.properties.indicate)?.uuid;
        }
        if (!this._serviceId || !this._writeCharId || !this._notifyCharId) throw new Error('No compatible UART service found on device');
      }

      await BleClient.startNotifications(
        this._deviceId, this._serviceId, this._notifyCharId,
        (dataView) => this._handleIncoming(dataViewToText(dataView))
      );

      this._connected = true;
      this._log(`Capacitor BLE connected — service ${this._serviceId} ✓`);
      return true;
    } catch (err) {
      this._log(`Capacitor BLE connect failed: ${err.message}`, 'ERROR');
      if (this._deviceId) { try { await BleClient.disconnect(this._deviceId); } catch (_) {} this._deviceId = null; }
      return false;
    }
  }

  _sendCapacitorBLE(cmd) {
    return new Promise(async (resolve, reject) => {
      if (!this._deviceId) return reject(new Error('No BLE device'));
      this._setupPending(cmd, resolve, reject);
      try {
        await BleClient.write(this._deviceId, this._serviceId, this._writeCharId, textToDataView(cmd + '\r'));
      } catch (err) {
        this._cancelPending(err.message);
        reject(err);
      }
    });
  }

  // ── Web Bluetooth (Laptop Native Mode) ────────────────────────────────────

  async _connectWebBluetooth() {
    try {
      this._log('Initialising Web Bluetooth…');
      if (!navigator.bluetooth) throw new Error('Web Bluetooth API not supported in this browser');

      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: OBD_SERVICE_UUIDS
      });

      this._webDevice = device;
      this._log(`Connecting to Web BT: ${device.name}…`);

      device.addEventListener('gattserverdisconnected', () => {
        this._connected = false;
        this._cancelPending('Web BT device disconnected');
        this._log('Web BT device disconnected unexpectedly', 'WARN');
        this.onDisconnected?.();
      });

      const server = await device.gatt.connect();
      
      let uartService = null;
      const services = await server.getPrimaryServices();
      for (const uuid of OBD_SERVICE_UUIDS) {
        uartService = services.find(s => s.uuid === uuid);
        if (uartService) break;
      }
      
      if (!uartService) {
        this._log('Known UART UUID not found, taking first available...', 'WARN');
        uartService = services[0];
      }
      
      if (!uartService) throw new Error('No services found on Web BT device');

      const characteristics = await uartService.getCharacteristics();
      this._webCharacteristicWrite = characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);
      this._webCharacteristicNotify = characteristics.find(c => c.properties.notify || c.properties.indicate);

      if (!this._webCharacteristicWrite || !this._webCharacteristicNotify) {
        throw new Error('Could not find write/notify characteristics');
      }

      await this._webCharacteristicNotify.startNotifications();
      this._webCharacteristicNotify.addEventListener('characteristicvaluechanged', this._handleIncomingWeb);

      this._connected = true;
      this._log(`Web BT connected ✓`);
      return true;

    } catch (err) {
      this._log(`Web BT connect failed: ${err.message}`, 'ERROR');
      if (this._webDevice && this._webDevice.gatt.connected) {
        this._webDevice.gatt.disconnect();
      }
      this._webDevice = null;
      return false;
    }
  }

  _handleIncomingWeb(event) {
    const value = event.target.value;
    const decoder = new TextDecoder('utf-8');
    this._handleIncoming(decoder.decode(value));
  }

  _sendWebBluetooth(cmd) {
    return new Promise(async (resolve, reject) => {
      if (!this._webDevice || !this._webCharacteristicWrite) return reject(new Error('No Web BT device'));
      this._setupPending(cmd, resolve, reject);
      try {
        const encoder = new TextEncoder();
        await this._webCharacteristicWrite.writeValue(encoder.encode(cmd + '\r'));
      } catch (err) {
        this._cancelPending(err.message);
        reject(err);
      }
    });
  }

  // ── Shared response handling ────────────────────────────────────────────────

  _setupPending(cmd, resolve, reject) {
    this._cancelPending('New command superseded previous');
    this._pendingResolve = resolve;
    this._pendingReject  = reject;
    this._buffer = '';
    this._cmdTimer = setTimeout(() => {
      this._log(`TIMEOUT waiting for response to: ${cmd}`, 'WARN');
      const r = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject  = null;
      this._cmdTimer       = null;
      this._buffer = '';
      r?.('TIMEOUT');
    }, CMD_TIMEOUT_MS);
  }

  _cancelPending(reason) {
    if (this._cmdTimer) { clearTimeout(this._cmdTimer); this._cmdTimer = null; }
    this._pendingResolve = null;
    this._pendingReject  = null;
    this._buffer = '';
  }

  _handleIncoming(text) {
    this._buffer += text;
    if (this._buffer.length > MAX_BUFFER_BYTES) {
      this._log('Buffer overflow — clearing', 'WARN');
      this._buffer = '';
      return;
    }
    if (this._buffer.includes('>')) {
      const raw = this._buffer.replace(/>/g, '').replace(/\r/g, '').trim();
      this._buffer = '';
      if (this._cmdTimer) { clearTimeout(this._cmdTimer); this._cmdTimer = null; }
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject  = null;
      resolve?.(raw);
    }
  }

  _log(msg, level = 'INFO') {
    const tag = this._mode === TRANSPORT.NATIVE ? (this._platform === 'web' ? '[WEB_BT]' : '[BLE]') : '[WS]';
    const line = `${tag} ${msg}`;
    console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](line);
    this.onLog?.(line);
  }
}

export const obdScanner = new BLEScanner();