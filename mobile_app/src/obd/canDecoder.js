/**
 * src/obd/canDecoder.js — CAN Bus Bitwise Decoder
 * Розшифровує сирі повідомлення CAN шини згідно з правилами DBC.
 */

// Допоміжна функція: перетворює HEX рядок у суцільний рядок бітів
const hexToBinaryString = (hex) => {
  if (!hex) return '';
  return hex.match(/.{1,2}/g)
    .map(byte => parseInt(byte, 16).toString(2).padStart(8, '0'))
    .join('');
};

/**
 * Основний декодер сигналів (Intel / Little Endian формат)
 * @param {string} hexData - Сирі дані (наприклад, "1A2B3C4D5E6F7A8B")
 * @param {number} startBit - Початковий біт з файлу DBC
 * @param {number} length - Довжина сигналу в бітах з файлу DBC
 * @param {number} factor - Множник (Factor) з DBC
 * @param {number} offset - Зміщення (Offset) з DBC
 * @param {boolean} isSigned - Чи є число знаковим (Signed)
 */
export const decodeCanSignal = (hexData, startBit, length, factor = 1, offset = 0, isSigned = false) => {
  const binStr = hexToBinaryString(hexData);
  if (binStr.length < startBit + length) return null; // Недостатньо даних

  // Вирізаємо потрібні біти
  const signalBits = binStr.substring(startBit, startBit + length);
  
  let rawValue = parseInt(signalBits, 2);

  // Обробка знака (Two's complement для від'ємних чисел)
  if (isSigned && (rawValue & (1 << (length - 1)))) {
    rawValue = rawValue - (1 << length);
  }

  // Застосовуємо математику DBC: (Raw * Factor) + Offset
  const physicalValue = (rawValue * factor) + offset;
  
  return parseFloat(physicalValue.toFixed(4));
};