/**
 * bleService.js — OBD-II transport layer
 *
 * Supports two transport modes, switchable at runtime:
 *   EMULATOR  → WebSocket → tcp-bridge.js → Python ELM327 emulator (desktop dev)
 *   NATIVE    → Capacitor BLE → physical ELM327 adapter (Android / iOS)
 *
 * Fixed bugs vs original:
 *  - Mode switching was broken (forceBluetooth never set, sendCommand ignored mode)
 *  - Buffer could grow forever if '>' prompt never arrived
 *  - BleClient.requestDevice had no timeout — hung forever
 *  - No reconnect / connection state tracking
 *  - sendCommand branched on platform instead of active mode
 */

import { Capacitor } from '@capacitor/core';
import { BleClient, dataViewToText, textToDataView } from '@capacitor-community/bluetooth-le';

// ── Constants ────────────────────────────────────────────────────────────────

/** Known OBD-II BLE service UUIDs (SPP / UART variants) */
const OBD_SERVICE_UUIDS = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '000018f0-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];

const WS_URL            = 'ws://localhost:8765';
const CMD_TIMEOUT_MS    = 4000;   // per-command timeout
const CONNECT_TIMEOUT_MS = 8000;  // BLE device scan timeout
const MAX_BUFFER_BYTES  = 4096;   // guard against runaway buffer

// ── Transport modes ──────────────────────────────────────────────────────────

export const TRANSPORT = {
  EMULATOR: 'emulator',
  NATIVE:   'native',
};

// ── BLEScanner class ─────────────────────────────────────────────────────────

class BLEScanner {
  constructor() {
    this._mode       = TRANSPORT.EMULATOR; // default — safe for web
    this._platform   = Capacitor.getPlatform(); // 'web' | 'android' | 'ios'
    this._connected  = false;

    // WebSocket transport state
    this._ws         = null;

    // Native BLE transport state
    this._deviceId   = null;
    this._serviceId  = null;
    this._writeCharId  = null;
    this._notifyCharId = null;

    // Response handling
    this._buffer         = '';
    this._pendingResolve = null;
    this._pendingReject  = null;
    this._cmdTimer       = null;

    // External log callback — set this before calling connect()
    this.onLog          = null;
    this.onDisconnected = null; // called when connection is lost unexpectedly
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Switch between emulator (WebSocket) and native BLE mode.
   * Safe to call while disconnected only.
   * @param {'emulator'|'native'} mode
   */
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

  /** Connect using the currently selected transport mode */
  async connect() {
    if (this._connected) {
      this._log('Already connected', 'WARN');
      return true;
    }

    const useNative = (this._mode === TRANSPORT.NATIVE) && (this._platform !== 'web');
    return useNative ? this._connectNative() : this._connectWebSocket();
  }

  /**
   * Send a raw command string and await the '>' prompt response.
   * Works regardless of transport mode.
   * @param {string} cmd  e.g. "010C", "ATZ", "03"
   * @returns {Promise<string>} raw response text (without the '>' prompt)
   */
  sendCommand(cmd) {
    if (!this._connected) return Promise.reject(new Error('Not connected'));
    return this._mode === TRANSPORT.NATIVE && this._platform !== 'web'
      ? this._sendNative(cmd)
      : this._sendWebSocket(cmd);
  }

  /** Gracefully close the active connection */
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

    this._log('Disconnected');
  }

  // ── WebSocket transport ─────────────────────────────────────────────────────

  _connectWebSocket() {
    return new Promise((resolve) => {
      this._log(`Connecting to bridge at ${WS_URL}…`);

      try {
        this._ws = new WebSocket(WS_URL);
      } catch (err) {
        this._log(`WebSocket create failed: ${err.message}`, 'ERROR');
        return resolve(false);
      }

      // Guard: if the bridge doesn't respond in time, fail cleanly
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
          // Capacitor can deliver binary Blobs even in web mode
          const text = (event.data instanceof Blob)
            ? await event.data.text()
            : String(event.data);
          this._handleIncoming(text);
        } catch (err) {
          this._log(`WS message parse error: ${err.message}`, 'ERROR');
        }
      };
    });
  }

  _sendWebSocket(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not open'));
      }
      this._setupPending(cmd, resolve, reject);
      this._ws.send(cmd);
    });
  }

  // ── Native BLE transport ────────────────────────────────────────────────────

  async _connectNative() {
    try {
      this._log('Initialising Bluetooth…');
      await BleClient.initialize({ androidNeverForLocation: true });

      // requestDevice with a timeout so it doesn't hang forever
      const device = await Promise.race([
        BleClient.requestDevice({ optionalServices: OBD_SERVICE_UUIDS }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Device scan timed out')), CONNECT_TIMEOUT_MS)
        ),
      ]);

      this._deviceId = device.deviceId;
      this._log(`Connecting to ${device.name ?? device.deviceId}…`);

      await BleClient.connect(this._deviceId, () => {
        // Unexpected disconnect callback
        this._connected = false;
        this._cancelPending('BLE device disconnected');
        this._log('BLE device disconnected unexpectedly', 'WARN');
        this.onDisconnected?.();
      });

      // Find the UART write + notify characteristics
      const services = await BleClient.getServices(this._deviceId);
      for (const svc of services) {
        let hasWrite = false, hasNotify = false;
        for (const char of svc.characteristics) {
          const p = char.properties;
          if (p.write || p.writeWithoutResponse) {
            hasWrite = true;
            this._writeCharId = char.uuid;
          }
          if (p.notify || p.indicate) {
            hasNotify = true;
            this._notifyCharId = char.uuid;
          }
        }
        if (hasWrite && hasNotify) {
          this._serviceId = svc.uuid;
          break;
        }
      }

      if (!this._serviceId) throw new Error('No UART service found on device');

      await BleClient.startNotifications(
        this._deviceId,
        this._serviceId,
        this._notifyCharId,
        (dataView) => this._handleIncoming(dataViewToText(dataView))
      );

      this._connected = true;
      this._log(`BLE connected — service ${this._serviceId} ✓`);
      return true;

    } catch (err) {
      this._log(`BLE connect failed: ${err.message}`, 'ERROR');
      // Clean up partial state
      if (this._deviceId) {
        try { await BleClient.disconnect(this._deviceId); } catch (_) {}
        this._deviceId = null;
      }
      return false;
    }
  }

  _sendNative(cmd) {
    return new Promise(async (resolve, reject) => {
      if (!this._deviceId) return reject(new Error('No BLE device'));
      this._setupPending(cmd, resolve, reject);
      try {
        await BleClient.write(
          this._deviceId,
          this._serviceId,
          this._writeCharId,
          textToDataView(cmd + '\r')
        );
      } catch (err) {
        this._cancelPending(err.message);
        reject(err);
      }
    });
  }

  // ── Shared response handling ────────────────────────────────────────────────

  /**
   * Register resolve/reject for the in-flight command and arm the timeout.
   * There is always at most one pending command (serial protocol).
   */
  _setupPending(cmd, resolve, reject) {
    // Clear any previous stale pending (shouldn't happen in normal flow)
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
      r?.('TIMEOUT'); // resolve with TIMEOUT string, not reject — caller handles it
    }, CMD_TIMEOUT_MS);
  }

  _cancelPending(reason) {
    if (this._cmdTimer) { clearTimeout(this._cmdTimer); this._cmdTimer = null; }
    this._pendingResolve = null;
    this._pendingReject  = null;
    this._buffer = '';
  }

  /**
   * Accumulate incoming bytes into buffer and fire resolve when we see '>'.
   * The ELM327 always terminates its response with '\r\n>' or just '>'.
   */
  _handleIncoming(text) {
    this._buffer += text;

    // Guard against runaway buffer (e.g. if device sends garbage)
    if (this._buffer.length > MAX_BUFFER_BYTES) {
      this._log('Buffer overflow — clearing', 'WARN');
      this._buffer = '';
      return;
    }

    if (this._buffer.includes('>')) {
      const raw = this._buffer
        .replace(/>/g, '')   // strip prompt
        .replace(/\r/g, '')  // strip CR
        .trim();

      this._buffer = '';

      if (this._cmdTimer) { clearTimeout(this._cmdTimer); this._cmdTimer = null; }

      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject  = null;

      resolve?.(raw);
    }
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  _log(msg, level = 'INFO') {
    const tag = this._mode === TRANSPORT.NATIVE ? '[BLE]' : '[WS]';
    const line = `${tag} ${msg}`;
    console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](line);
    this.onLog?.(line);
  }
}

// Singleton — the whole app shares one transport instance
export const obdScanner = new BLEScanner();