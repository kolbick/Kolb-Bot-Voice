import { app, BrowserWindow, ipcMain, session } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import WebSocket from 'ws';
import { executeTool } from './tools.js';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load config from project root .env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RELAY_URL = process.env.RELAY_URL || '';
const AGENT_ID = process.env.AGENT_ID || '';

let mainWindow = null;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;

function connectRelay(url) {
  if (!url) {
    console.log('[Relay] No RELAY_URL configured.');
    mainWindow?.webContents.send('relay-status', { connected: false, error: 'No relay URL configured' });
    return;
  }

  console.log(`[Relay] Connecting to ${url}...`);
  mainWindow?.webContents.send('relay-status', { connected: false, connecting: true });

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[Relay] Failed to create WebSocket:', err.message);
    scheduleReconnect(url);
    return;
  }

  // Keep-alive ping every 25s to prevent cloudflared from closing idle connections
  const pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25000);

  ws.on('open', () => {
    console.log('[Relay] Connected');
    reconnectDelay = 2000; // Reset backoff
    mainWindow?.webContents.send('relay-status', { connected: true });
  });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error('[Relay] Invalid JSON message');
      return;
    }
    const { id, tool, params } = msg;
    console.log(`[Tool] ${tool}`, params);
    try {
      const result = await executeTool(tool, params);
      ws.send(JSON.stringify({ id, result }));
    } catch (err) {
      console.error(`[Tool] ${tool} failed:`, err.message);
      ws.send(JSON.stringify({ id, error: err.message }));
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (relay.client === ws) relay.client = null;
    console.log('[Relay] Disconnected.');
    mainWindow?.webContents.send('relay-status', { connected: false });
    scheduleReconnect(url);
  });

  ws.on('error', (err) => {
    console.error('[Relay] Error:', err.message);
    // 'close' event fires after 'error', so reconnect is handled there
  });
}

function scheduleReconnect(url) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[Relay] Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // Exponential backoff, max 30s
    connectRelay(url);
  }, reconnectDelay);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Kolb-Bot Voice',
    backgroundColor: '#0a0a0f',
  });

  // Load the Vite-built renderer
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Allow microphone access for ElevenLabs voice conversation
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera'];
    callback(allowed.includes(permission));
  });

  createWindow();
  connectRelay(RELAY_URL);
});

app.on('window-all-closed', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

// IPC handlers
ipcMain.handle('get-config', () => ({
  agentId: AGENT_ID,
  relayUrl: RELAY_URL,
  firstLaunch: !RELAY_URL,
}));

ipcMain.handle('save-relay-url', (event, newUrl) => {
  // Reconnect with new URL immediately
  if (ws) ws.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectDelay = 2000;
  connectRelay(newUrl);
  return { ok: true };
});
