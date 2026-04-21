// src/obd/index.js
import { obdScanner } from '../services/bleService.js'; // Зверніть увагу: папка services (або service, залежно від того, як вона у вас називається)
import { commands } from './commands.js';

class OBDManager {
  constructor() {
    this.scanner = obdScanner; // Ваша поточна логіка з Capacitor/WebSockets зберігається!
    this.commands = commands;
  }

  // --- ДОДАНО: Функція підключення ---
  async connect() {
    if (!this.scanner) return false;
    return await this.scanner.connect();
  }

  // --- ДОДАНО: Функція ініціалізації (AT-команди) ---
  async initEngine() {
    if (!this.scanner) return;
    await this.scanner.sendCommand('ATZ');
    await new Promise(r => setTimeout(r, 1000));
    await this.scanner.sendCommand('ATE0');
    await this.scanner.sendCommand('ATL0');
    await this.scanner.sendCommand('ATSP0');
  }

  // --- ДОДАНО: Функція відключення ---
  disconnect() {
    if (this.scanner && typeof this.scanner.disconnect === 'function') {
      this.scanner.disconnect();
    }
  }

  /**
   * Виконує команду OBDCommand та повертає розшифрований результат
   * @param {OBDCommand} cmdObj 
   * @returns {Promise<{value: any, raw: string, unit: string} | null>}
   */
  async query(cmdObj) {
    if (!cmdObj || !cmdObj.command) {
      console.error("[OBD] Невірна команда");
      return null;
    }

    try {
      const response = await this.scanner.sendCommand(cmdObj.command);
      if (!response) return null;
      
      const cleanResponse = response.replace(/\s/g, '').replace(/\r/g, '');

      if (cleanResponse.includes('NODATA') || cleanResponse.includes('TIMEOUT') || cleanResponse.includes('ERROR')) {
        return null; 
      }

      // ВИПРАВЛЕНО: Додаємо 0x40 (шістнадцяткове), а не десяткове 40
      const modeInt = parseInt(cmdObj.command.substring(0, 2), 16);
      const expectedPrefix = (modeInt + 0x40).toString(16).toUpperCase() + cmdObj.command.substring(2);
      
      const dataIndex = cleanResponse.indexOf(expectedPrefix);
      
      if (dataIndex !== -1) {
        const hexData = cleanResponse.substring(dataIndex + expectedPrefix.length);
        
        let targetHex = hexData;
        // Якщо команда має фіксовану довжину (> 0), відрізаємо зайве
        // Якщо bytes === 0 (як у помилках), беремо всі дані до кінця
        if (cmdObj.bytes > 0) {
            if (hexData.length < cmdObj.bytes * 2) return null;
            targetHex = hexData.substring(0, cmdObj.bytes * 2);
        }
        
        if (typeof cmdObj.decoder !== 'function') {
            console.warn(`[OBD] ПОПЕРЕДЖЕННЯ: Відсутній декодер для команди ${cmdObj.name}`);
            return null;
        }
        
        const decodedValue = cmdObj.decoder(targetHex);

        return {
          value: decodedValue,
          unit: cmdObj.unit,
          raw: targetHex,
          desc: cmdObj.desc,
          name: cmdObj.name
        };
      }
      return null;

    } catch (error) {
      console.error(`[OBD] Помилка виконання ${cmdObj?.name}:`, error);
      return null;
    }
  }
}

export const obd = new OBDManager();