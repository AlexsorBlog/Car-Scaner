/**
 * Парсить сирий текст .dbc файлу та повертає структурований JSON
 */
export const parseRawDbcToJson = (dbcText) => {
  const lines = dbcText.split('\n');
  const result = {};
  let currentMessageId = null;

  // Регулярні вирази для пошуку
  // BO_ 3 STEER_SENSOR: 8 XXX
  const msgRegex = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+):\s+(\d+)/;
  
  // SG_ STEER_ANGLE : 3|12@0- (-0.5,0) [-500|500] "degrees" XXX
  const sigRegex = /^\s*SG_\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\|(\d+)@(\d+)([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]+)\|([^\]]+)\]\s*"([^"]*)"/;

  for (let line of lines) {
    line = line.trim();

    // Шукаємо блок повідомлення (Message / Frame)
    const msgMatch = line.match(msgRegex);
    if (msgMatch) {
      currentMessageId = msgMatch[1]; // У десятковому форматі (напр., 3)
      result[currentMessageId] = {
        name: msgMatch[2],
        lengthBytes: parseInt(msgMatch[3], 10),
        signals: {}
      };
      continue;
    }

    // Шукаємо сигнали всередині повідомлення
    const sigMatch = line.match(sigRegex);
    if (sigMatch && currentMessageId) {
      result[currentMessageId].signals[sigMatch[1]] = {
        name: sigMatch[1],
        startBit: parseInt(sigMatch[2], 10),
        length: parseInt(sigMatch[3], 10),
        endianness: sigMatch[4] === '0' ? 'Motorola' : 'Intel',
        isSigned: sigMatch[5] === '-',
        factor: parseFloat(sigMatch[6]),
        offset: parseFloat(sigMatch[7]),
        unit: sigMatch[10]
      };
    }
  }

  return result; // Це ваш готовий JSON!
};