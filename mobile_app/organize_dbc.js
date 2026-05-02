const fs = require('fs');
const path = require('path');

// Поточна папка (де лежить скрипт)
const dirPath = __dirname;

// Мапа префіксів для розумного сортування
// Формат: "префікс_файлу": "назва_папки"
const brandMap = {
  'acura': 'honda',     // Часто Acura та Honda використовують спільні протоколи
  'honda': 'honda',
  'bmw': 'bmw',
  'cadillac': 'gm',     // Cadillac належить GM
  'gm': 'gm',
  'chrysler': 'chrysler',
  'fca': 'chrysler',    // FCA (Fiat Chrysler Automobiles)
  'ford': 'ford',
  'gwm': 'gwm',
  'hongqi': 'hongqi',
  'hyundai': 'hyundai',
  'kia': 'hyundai',     // Kia та Hyundai ділять платформи
  'luxgen': 'luxgen',
  'mazda': 'mazda',
  'mercedes': 'mercedes',
  'nissan': 'nissan',
  'opel': 'opel',
  'psa': 'psa',
  'rivian': 'rivian',
  'tesla': 'tesla',
  'toyota': 'toyota',
  'volvo': 'volvo',
  'vw': 'vw',
  'comma': 'comma',
  'esr': 'misc'         // Радари Delphi/Aptiv ESR
};

// Читаємо всі файли в папці
fs.readdir(dirPath, (err, files) => {
  if (err) {
    return console.error('Помилка читання папки:', err);
  }

  // Фільтруємо тільки .dbc файли з кореня (не чіпаємо папки)
  const dbcFiles = files.filter(f => f.toLowerCase().endsWith('.dbc') && fs.lstatSync(path.join(dirPath, f)).isFile());

  let movedCount = 0;

  dbcFiles.forEach(file => {
    // Шукаємо ключове слово до першого символу "_" (наприклад "ford" з "ford_fusion_2018.dbc")
    const prefix = file.split('_')[0].toLowerCase();
    
    // Визначаємо цільову папку
    let targetFolder = 'misc'; // Папка за замовчуванням для невідомих
    
    // Перевіряємо, чи є префікс у нашій мапі
    for (const [key, folder] of Object.entries(brandMap)) {
      if (file.toLowerCase().startsWith(key)) {
        targetFolder = folder;
        break;
      }
    }

    const targetDirPath = path.join(dirPath, targetFolder);

    // Створюємо папку, якщо її ще немає
    if (!fs.existsSync(targetDirPath)) {
      fs.mkdirSync(targetDirPath, { recursive: true });
    }

    // Переміщуємо файл
    const oldPath = path.join(dirPath, file);
    const newPath = path.join(targetDirPath, file);

    fs.renameSync(oldPath, newPath);
    console.log(`📦 Переміщено: ${file}  --->  /${targetFolder}/`);
    movedCount++;
  });

  console.log(`\n✅ Готово! Розсортовано ${movedCount} файлів.`);
});