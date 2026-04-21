import * as decoders from './decoders.js';
import commandsData from './obd_commands.json';

export class OBDCommand {
  constructor(name, desc, command, totalBytes, decoderStr) {
    this.name = name;
    this.desc = desc;
    this.command = command;
    
    // В python-obd 'bytes' включає 2 байти ехо (наприклад 41 0C). Нам потрібні тільки дані.
    this.bytes = (totalBytes > 2) ? totalBytes - 2 : 0; 
    
    // 1. Призначаємо математичну функцію
    this.decoder = this.parseDecoder(decoderStr);
    
    // 2. Автоматично вгадуємо одиниці виміру за назвою
    this.unit = this.guessUnit(desc, decoderStr);
  }

  parseDecoder(decoderStr) {
    // Якщо це формат типу "uas(0x07)"
    const uasMatch = decoderStr.match(/uas\((0x[0-9A-Fa-f]+)\)/i);
    if (uasMatch) {
        const uasId = uasMatch[1];
        return (hex) => decoders.decodeUas(hex, uasId);
    }

    // Якщо це формат типу "encoded_string(17)"
    const strMatch = decoderStr.match(/encoded_string\((\d+)\)/);
    if (strMatch) {
        const length = parseInt(strMatch[1], 10);
        return (hex) => decoders.decodeEncodedString(hex, length);
    }

    // Якщо це стандартний декодер (наприклад "percent")
    if (decoders[decoderStr]) {
        return decoders[decoderStr];
    }

    console.warn(`[OBD] Декодер '${decoderStr}' не знайдено. Використовуємо сирий рядок.`);
    return decoders.raw_string;
  }

  guessUnit(desc, decoderStr) {
    const d = desc.toLowerCase();
    if (d.includes('rpm')) return 'об/хв';
    if (d.includes('speed')) return 'км/год';
    if (d.includes('temp')) return '°C';
    if (d.includes('pressure')) return 'кПа';
    if (d.includes('voltage')) return 'В';
    if (d.includes('rate') || d.includes('maf')) return 'г/с';
    if (decoderStr.includes('percent')) return '%';
    if (decoderStr.includes('0x12')) return 'сек';
    if (decoderStr.includes('0x25')) return 'км';
    if (d.includes('advance') || d.includes('timing')) return '°';
    return '';
  }
}

// Зберігаємо всі-всі команди сюди
export const commands = {};

// Перебираємо весь JSON і створюємо об'єкти
for (const modeKey in commandsData) {
    const modeArray = commandsData[modeKey];
    
    for (const cmdData of modeArray) {
        // Ключем об'єкта буде його назва (наприклад commands.RPM)
        commands[cmdData.name] = new OBDCommand(
            cmdData.name,
            cmdData.description,
            cmdData.cmd,
            cmdData.bytes,
            cmdData.decoder
        );
    }
}

// Щоб у React не намагатися зациклити всі 150 команд одночасно (це "вб'є" Bluetooth), 
// ми експортуємо зручний масив тільки для Mode 1 (Поточні дані)
// Щоб у React не намагатися зациклити всі 150 команд одночасно, 
// ми експортуємо зручний масив тільки для Mode 1 (Поточні дані)
export const mode1Commands = commandsData.mode1.map(c => commands[c.name]);

// Експортуємо Mode 3 (Зчитування помилок), щоб до нього можна було звернутися як mode3.GET_DTC
export const mode3 = {};
if (commandsData.mode3) {
    commandsData.mode3.forEach(cmdData => {
        mode3[cmdData.name] = commands[cmdData.name];
    });
}

// Експортуємо Mode 4 (Очищення помилок) на майбутнє
export const mode4 = {};
if (commandsData.mode4) {
    commandsData.mode4.forEach(cmdData => {
        mode4[cmdData.name] = commands[cmdData.name];
    });
}