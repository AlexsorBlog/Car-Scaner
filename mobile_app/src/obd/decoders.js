export const hexToInt = (hex) => parseInt(hex, 16);

// Базові
export const raw_string = (hex) => hex;
export const drop = (hex) => null;
export const percent = (hex) => Math.round((hexToInt(hex) * 100.0) / 255.0);
export const percent_centered = (hex) => Math.round(((hexToInt(hex) - 128) * 100.0) / 128.0);
export const temp = (hex) => Math.round(hexToInt(hex) - 40);
export const pressure = (hex) => hexToInt(hex);
export const fuel_pressure = (hex) => hexToInt(hex) * 3;
export const current_centered = (hex) => (hexToInt(hex.substring(0, 4)) / 256.0) - 128;
export const sensor_voltage = (hex) => (hexToInt(hex.substring(0, 2)) / 200.0).toFixed(2);
export const sensor_voltage_big = (hex) => ((hexToInt(hex.substring(4, 8)) * 8.0) / 65535).toFixed(2);

export const absolute_load = (hex) => Math.round((hexToInt(hex) * 100.0) / 255.0);
export const timing_advance = (hex) => (hexToInt(hex.substring(0, 2)) / 2.0) - 64;
export const inject_timing = (hex) => (hexToInt(hex) - 26880) / 128.0;
export const fuel_rate = (hex) => (hexToInt(hex) * 0.05).toFixed(2);
export const max_maf = (hex) => hexToInt(hex.substring(0, 2)) * 10;
export const count = (hex) => hexToInt(hex);

// Розумний парсер для сімейства UAS (Units And Scaling)
export const decodeUas = (hex, id) => {
    const val = hexToInt(hex);
    switch(id.toLowerCase()) {
        case '0x01': return val;
        case '0x07': return val / 4.0; // RPM
        case '0x09': return val; // Speed
        case '0x0b': return (val / 1000.0).toFixed(1); // Voltage
        case '0x12': return val; // Seconds
        case '0x16': return (val * 0.1) - 40.0; // Temp Catalyst
        case '0x19': return (val * 0.079).toFixed(2); // kPa
        case '0x1b': return val; // kPa (Abs pressure)
        case '0x1e': return (val * 0.0000305).toFixed(4); // Ratio
        case '0x25': return val; // km
        case '0x27': return (val / 100.0).toFixed(2); // MAF
        case '0x34': return val; // minutes
        default: return val; // Fallback
    }
};

// Розшифровка рядків (наприклад VIN-коду)
export const decodeEncodedString = (hex, length) => {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str.replace(/[^ -~]/g, '').trim(); 
};

// Заглушки для складних бінарних даних (щоб не крашити додаток)
export const pid = (hex) => hex;
export const status = (hex) => hex;
export const single_dtc = (hex) => hex;
export const fuel_status = (hex) => hex;
export const air_status = (hex) => hex;
export const obd_compliance = (hex) => hex;
export const o2_sensors = (hex) => hex;
export const o2_sensors_alt = (hex) => hex;
export const aux_input_status = (hex) => hex;
export const fuel_type = (hex) => hex;
export const abs_evap_pressure = (hex) => (hexToInt(hex) / 200.0).toFixed(2);
export const evap_pressure_alt = (hex) => hexToInt(hex) - 32767;
export const monitor = (hex) => hex;
export const cvn = (hex) => hex;
export const elm_voltage = (hex) => hex;
export const evap_pressure = (hex) => hex; // Поки що ставимо заглушку
// Декодер для зчитування DTC (Mode 03, 07)
export const dtc = (hex) => {
    const codes = [];
    
    // Кожна помилка займає 2 байти (4 символи HEX). Розбиваємо рядок на шматки по 4 символи.
    for (let i = 0; i < hex.length; i += 4) {
        const chunk = hex.substring(i, i + 4);
        
        // Автомобіль часто добиває порожнє місце нулями (0000). Їх ми ігноруємо.
        if (chunk === '0000' || chunk.length < 4) continue;

        // Беремо перший байт
        const byte1 = parseInt(chunk.substring(0, 2), 16);
        
        // Визначаємо першу літеру (верхні 2 біти першого байта)
        const letterIdx = byte1 >> 6;
        const letters = ['P', 'C', 'B', 'U'];
        const letter = letters[letterIdx];

        // Визначаємо першу цифру (наступні 2 біти)
        const digit1 = (byte1 >> 4) & 0x03;

        // Решта 3 цифри - це просто шматок HEX рядка
        const digit234 = chunk.substring(1, 4);

        codes.push(`${letter}${digit1}${digit234}`);
    }
    
    return codes; // Повертає масив, наприклад: ['P0104', 'P0300']
};