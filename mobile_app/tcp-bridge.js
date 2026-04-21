import net from 'net';
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8765 });
console.log('[МІСТ] Очікування підключення від React (ws://localhost:8765)...');

wss.on('connection', function connection(ws) {
    console.log('[МІСТ] React-додаток ПІДКЛЮЧЕНО!');

    const tcpClient = new net.Socket();
    tcpClient.connect(35000, '127.0.0.1', function() {
        console.log('[МІСТ] Зʼєднано з Python Емулятором на порту 35000!');
    });

    // Отримуємо відповідь від Python і шлемо в React
    tcpClient.on('data', function(data) {
        const text = data.toString('utf-8');
        // Показуємо в консолі моста точну відповідь емулятора з усіма прихованими символами (\r)
        console.log(`[PYTHON -> REACT]: ${JSON.stringify(text)}`);
        ws.send(text);
    });

    // Отримуємо команду від React і шлемо в Python
    ws.on('message', function incoming(message) {
        const text = message.toString('utf-8');
        console.log(`[REACT -> PYTHON]: ${JSON.stringify(text)}`);
        tcpClient.write(text + '\r');
    });

    ws.on('close', () => tcpClient.destroy());
    tcpClient.on('close', () => ws.close());
    tcpClient.on('error', (err) => console.error('[ПОМИЛКА TCP]', err.message));
});