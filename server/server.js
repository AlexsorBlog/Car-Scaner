require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json()); // Дозволяє серверу читати JSON від React

// Підключення до бази даних
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Middleware для перевірки токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Формат: "Bearer <token>"

  if (!token) return res.status(401).json({ error: "Немає доступу" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Токен недійсний або закінчився" });
    req.user = user; // Зберігаємо дані користувача для наступних функцій
    next();
  });
};

// Автоматичне створення таблиці при запуску
async function initDB() {
  // 1. Створюємо таблицю (якщо її ще немає)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ВИПРАВЛЕННЯ: Додаємо колонки до існуючої таблиці, якщо ми їх забули раніше
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100) DEFAULT 'Новий Користувач';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100);
  `);

  // 2. Таблиця автомобілів
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      make VARCHAR(50) DEFAULT 'Tesla',
      model VARCHAR(50) DEFAULT 'Model S Plaid',
      vin VARCHAR(20) DEFAULT '5YJSA1E28LF******',
      odometer VARCHAR(20) DEFAULT '0 км'
    );
  `);
  console.log("Database initialized and updated");
}
initDB();

// API: Оновлення профілю та даних авто (ЗАХИЩЕНИЙ МАРШРУТ)
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  const { name, email, make, model, vin } = req.body;

  try {
    // Оновлюємо таблицю користувача
    await pool.query(
      'UPDATE users SET name = $1, email = $2 WHERE id = $3',
      [name, email, req.user.userId]
    );

    // Оновлюємо таблицю автомобіля
    await pool.query(
      'UPDATE vehicles SET make = $1, model = $2, vin = $3 WHERE user_id = $4',
      [make, model, vin, req.user.userId]
    );

    res.json({ message: "Профіль успішно оновлено" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка оновлення профілю" });
  }
});

// API Ендпоінт для авторизації
app.post('/api/auth/login', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Номер телефону обов'язковий" });
  }

  try {
    // Шукаємо користувача
    let result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    let user = result.rows[0];

    // Якщо його немає — створюємо (Реєстрація)
    if (!user) {
      result = await pool.query(
        'INSERT INTO users (phone) VALUES ($1) RETURNING *',
        [phone]
      );
      user = result.rows[0];
    }

    // Створюємо "ключ доступу" (Токен)
    const token = jwt.sign({ userId: user.id, phone: user.phone }, process.env.JWT_SECRET);

    res.json({ message: "Успішно", user, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера" });
  }
});

const PORT = process.env.PORT || 3000;

// API: Отримання профілю та даних авто (ЗАХИЩЕНИЙ МАРШРУТ)
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    // Шукаємо користувача
    const userResult = await pool.query('SELECT id, phone, name, email FROM users WHERE id = $1', [req.user.userId]);
    const user = userResult.rows[0];

    // Шукаємо його авто
    let vehicleResult = await pool.query('SELECT * FROM vehicles WHERE user_id = $1', [user.id]);
    
    // Якщо авто ще немає (новий юзер) - створюємо базовий запис
    if (vehicleResult.rows.length === 0) {
      vehicleResult = await pool.query(
        'INSERT INTO vehicles (user_id) VALUES ($1) RETURNING *',
        [user.id]
      );
    }
    const vehicle = vehicleResult.rows[0];

    // Формуємо відповідь у тому форматі, якого очікує наш React фронтенд
    res.json({
      user: {
        name: user.name,
        email: user.email || 'Не вказано',
        phone: user.phone,
        vehicle: `${vehicle.make} ${vehicle.model}`,
        vin: vehicle.vin,
        odometer: vehicle.odometer
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});