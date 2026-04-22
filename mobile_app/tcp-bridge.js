/**
 * tcp-bridge.js — WebSocket ↔ TCP bridge
 *
 * Bridges the browser/React app (WebSocket) to the Python ELM327 emulator (TCP).
 *
 * Fixed vs original:
 *  - No reconnect if Python emulator restarted → automatic TCP reconnect with backoff
 *  - No graceful shutdown → SIGTERM/SIGINT handlers close connections cleanly
 *  - Single WebSocket client only → supports multiple simultaneous browser tabs
 *  - No keepalive → TCP socket keepalive enabled to detect silent drops
 *  - Errors only logged, not surfaced to the browser → sends error frame to client
 *
 * Usage:
 *   node tcp-bridge.js
 *
 * Env vars (optional):
 *   WS_PORT    WebSocket port (default 8765)
 *   TCP_HOST   Emulator host  (default 127.0.0.1)
 *   TCP_PORT   Emulator port  (default 35000)
 */

import net            from 'net';
import { WebSocketServer, WebSocket } from 'ws';

// ── Config ────────────────────────────────────────────────────────────────────

const WS_PORT  = parseInt(process.env.WS_PORT  ?? '8765',  10);
const TCP_HOST = process.env.TCP_HOST           ?? '127.0.0.1';
const TCP_PORT = parseInt(process.env.TCP_PORT  ?? '35000', 10);

const RECONNECT_BASE_MS  = 1000;
const RECONNECT_MAX_MS   = 16000;

// ── Logging ───────────────────────────────────────────────────────────────────

const ts  = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const err = (msg) => console.error(`[${ts()}] ERROR: ${msg}`);

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });
log(`Bridge ready — listening on ws://localhost:${WS_PORT}`);
log(`Will connect to Python emulator at ${TCP_HOST}:${TCP_PORT}`);

/** Track all active client sessions for clean shutdown */
const sessions = new Set();

wss.on('connection', (ws, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  log(`[${clientId}] Browser connected`);

  const session = new BridgeSession(ws, clientId);
  sessions.add(session);
  session.start();

  ws.on('close', () => {
    log(`[${clientId}] Browser disconnected`);
    session.destroy();
    sessions.delete(session);
  });
});

// ── BridgeSession ─────────────────────────────────────────────────────────────

class BridgeSession {
  constructor(ws, clientId) {
    this._ws         = ws;
    this._clientId   = clientId;
    this._tcp        = null;
    this._destroyed  = false;
    this._reconnectMs = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
  }

  start() {
    this._connectTcp();
  }

  destroy() {
    this._destroyed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._tcp) { try { this._tcp.destroy(); } catch (_) {} this._tcp = null; }
  }

  // ── TCP connection ──────────────────────────────────────────────────────────

  _connectTcp() {
    if (this._destroyed) return;

    log(`[${this._clientId}] Connecting to emulator ${TCP_HOST}:${TCP_PORT}…`);

    const tcp = new net.Socket();
    this._tcp = tcp;

    // Enable TCP keepalive so we detect silent disconnects
    tcp.setKeepAlive(true, 5000);
    tcp.setTimeout(30000); // 30 s idle timeout

    tcp.connect(TCP_PORT, TCP_HOST, () => {
      log(`[${this._clientId}] Emulator connected ✓`);
      this._reconnectMs = RECONNECT_BASE_MS; // reset backoff
    });

    // Emulator → Browser
    tcp.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      log(`[${this._clientId}] PY→WS: ${JSON.stringify(text)}`);
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(text);
      }
    });

    // Browser → Emulator
    this._ws.on('message', (message) => {
      if (this._destroyed || !tcp || tcp.destroyed) return;
      const text = message.toString('utf-8');
      log(`[${this._clientId}] WS→PY: ${JSON.stringify(text)}`);
      tcp.write(text + '\r');
    });

    tcp.on('timeout', () => {
      log(`[${this._clientId}] TCP idle timeout — reconnecting`);
      tcp.destroy();
    });

    tcp.on('error', (e) => {
      err(`[${this._clientId}] TCP error: ${e.message}`);
    });

    tcp.on('close', () => {
      if (this._destroyed) return;
      log(`[${this._clientId}] Emulator disconnected — retry in ${this._reconnectMs}ms`);

      // Notify the browser so it can show a "reconnecting" state
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send('BRIDGE_DISCONNECTED\r\n>');
      }

      this._reconnectTimer = setTimeout(() => {
        // Exponential backoff, capped at RECONNECT_MAX_MS
        this._reconnectMs = Math.min(this._reconnectMs * 2, RECONNECT_MAX_MS);
        this._connectTcp();
      }, this._reconnectMs);
    });
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  log(`Received ${signal} — shutting down…`);
  for (const session of sessions) session.destroy();
  sessions.clear();
  wss.close(() => {
    log('WebSocket server closed');
    process.exit(0);
  });
  // Force exit if close takes too long
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));