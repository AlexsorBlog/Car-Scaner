import { Capacitor } from '@capacitor/core';
import { BleClient, dataViewToText, textToDataView } from '@capacitor-community/bluetooth-le';

const OBD_UUIDS = [
  '0000ffe0-0000-1000-8000-00805f9b34fb', 
  '0000fff0-0000-1000-8000-00805f9b34fb', 
  '000018f0-0000-1000-8000-00805f9b34fb', 
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', 
  '49535343-fe7d-4ae5-8fa9-9fafd205e455'
];

class BLEScanner {
  constructor() {
    this.platform = Capacitor.getPlatform();
    this.forceProxy = false; // НОВА ЗМІННА: за замовчуванням false
    this.buffer = '';
    this.pendingResolve = null;
    this.onLog = null;

    this.deviceId = null;
    this.serviceId = null;
    this.writeCharId = null;
    this.notifyCharId = null;

    this.ws = null; 
  }

  log(msg, type = 'INFO') {
    const prefix = this.platform === 'web' ? '[EMULATOR]' : '[NATIVE]';
    if (this.onLog) this.onLog(`${prefix} ${msg}`);
    console.log(`${prefix} [${type}] ${msg}`);
  }

  async connect() {
    // Якщо увімкнено форсування проксі АБО ми в браузері (і не форсуємо Bluetooth)
    if (this.forceProxy || (this.platform === 'web' && !this.forceBluetooth)) {
      return this.connectWebSocket();
    } else {
      return this.connectNative();
    }
  }

  sendCommand(cmd) {
    if (this.platform === 'web') return this.sendCommandWebSocket(cmd);
    else return this.sendCommandNative(cmd);
  }

  async disconnect() {
    if (this.platform === 'web' && this.ws) {
      this.ws.close();
      this.ws = null;
    } else if (this.deviceId) {
      try { await BleClient.disconnect(this.deviceId); } catch (e) {}
      this.deviceId = null;
    }
    this.log('Відключено', 'INFO');
  }

  // ==========================================
  // 💻 ЛОГІКА ДЛЯ НОУТБУКА (WEBSOCKET -> PYTHON)
  // ==========================================
  connectWebSocket() {
    return new Promise((resolve) => {
      this.log('Підключення до моста (ws://localhost:8765)...');
      
      try {
        this.ws = new WebSocket('ws://localhost:8765');
      } catch (e) {
        this.log(`Помилка створення WebSocket: ${e.message}`);
        resolve(false);
        return;
      }

      this.ws.onopen = () => {
        this.log('Підключено до Емулятора!');
        resolve(true);
      };

      this.ws.onerror = (error) => {
        this.log('Помилка! Міст tcp-bridge.js не відповідає.');
        resolve(false);
      };

      // --- ОСЬ ЦЕЙ БЛОК ВИРІШУЄ ПРОБЛЕМУ ---
      this.ws.onmessage = async (event) => {
        try {
          let text = event.data;
          
          // Якщо браузер отримав бінарний Blob замість звичайного тексту
          if (text instanceof Blob) {
            text = await text.text();
          } else if (typeof text !== 'string') {
            text = String(text);
          }

          // Виводимо в консоль F12 точний рядок, який прийшов у браузер
          console.log("[DEBUG WS RX]:", JSON.stringify(text)); 
          
          this.handleIncomingData(text);
        } catch (err) {
          console.error("[DEBUG WS ERROR]:", err);
        }
      };
    });
  }

  sendCommandWebSocket(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject('Немає підключення');
      }
      this.setupPromise(resolve, cmd);
      this.ws.send(cmd);
    });
  }

  // ==========================================
  // 📱 ЛОГІКА ДЛЯ ТЕЛЕФОНУ (CAPACITOR NATIVE)
  // ==========================================
  async connectNative() {
    try {
      this.log('Ініціалізація Native Bluetooth...');
      await BleClient.initialize();
      const device = await BleClient.requestDevice({ optionalServices: OBD_UUIDS });
      this.deviceId = device.deviceId;
      await BleClient.connect(this.deviceId, () => this.disconnect());

      const services = await BleClient.getServices(this.deviceId);
      for (const service of services) {
        let hasW = false, hasN = false;
        for (const char of service.characteristics) {
          if (char.properties.write || char.properties.writeWithoutResponse) { hasW = true; this.writeCharId = char.uuid; }
          if (char.properties.notify || char.properties.indicate) { hasN = true; this.notifyCharId = char.uuid; }
        }
        if (hasW && hasN) { this.serviceId = service.uuid; break; }
      }

      if (!this.writeCharId) throw new Error('UART не знайдено');

      await BleClient.startNotifications(this.deviceId, this.serviceId, this.notifyCharId, (value) => {
        this.handleIncomingData(dataViewToText(value));
      });

      this.log('Native-канал відкрито!');
      return true;
    } catch (error) {
      this.log(`Помилка Native: ${error.message}`);
      return false;
    }
  }

  sendCommandNative(cmd) {
    return new Promise(async (resolve, reject) => {
      if (!this.deviceId) return reject('Немає Native-підключення');
      this.setupPromise(resolve, cmd);

      try {
        await BleClient.write(this.deviceId, this.serviceId, this.writeCharId, textToDataView(cmd + '\r'));
      } catch (err) {
        reject(err);
      }
    });
  }

  setMode(useEmulator) {
    this.forceProxy = useEmulator;
    console.log(`[OBD] Режим змінено на: ${useEmulator ? 'Емулятор (WS)' : 'Bluetooth (Native)'}`);
  }

  // ==========================================
  // СПІЛЬНІ ФУНКЦІЇ ДЛЯ ОБРОБКИ ДАНИХ
  // ==========================================
  setupPromise(resolve, cmd) {
    this.pendingResolve = resolve;
    this.buffer = '';
    setTimeout(() => {
      if (this.pendingResolve) {
        this.log(`RX: TIMEOUT (${cmd})`, 'ERROR');
        this.pendingResolve('TIMEOUT');
        this.pendingResolve = null;
      }
    }, 3000);
  }

  handleIncomingData(text) {
    this.buffer += text;
    
    // Показуємо, як виглядає буфер у даний момент
    // console.log(`[DEBUG BUFFER]: ${JSON.stringify(this.buffer)}`);
    
    if (this.buffer.includes('>')) {
      const response = this.buffer.replace(/>/g, '').trim();
      this.buffer = ''; 
      if (this.pendingResolve) {
        // Ми успішно отримали відповідь!
        this.pendingResolve(response);
        this.pendingResolve = null;
      }
    }
  }
}

export const obdScanner = new BLEScanner();