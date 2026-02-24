/**
 * Kolb-Bot gateway WebSocket client.
 * Speaks the kolb-bot gateway protocol (version 3) and provides:
 *   - call(method, params) → Promise<payload>
 *   - onEvent(fn) → unsubscribe function
 * Reconnects automatically on disconnect.
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = process.env.KOLB_BOT_GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.KOLB_BOT_GATEWAY_TOKEN || 'kolb-bot-portal-2026';
const PROTOCOL_VERSION = 3;
const RECONNECT_DELAY_MS = 3000;
const CALL_TIMEOUT_MS = 15000;

class GatewayClient {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.listeners = new Set();
    this.helloOk = null;
    this._connect();
  }

  _connect() {
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
    }
    this.ready = false;
    // Set Origin to the gateway host so the origin-check passes
    this.ws = new WebSocket(GATEWAY_URL, { headers: { Origin: 'http://localhost:18789' } });

    this.ws.on('open', () => {
      // Connection open — wait for connect.challenge event
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Server-sent event
      if (msg.type === 'event') {
        if (msg.event === 'connect.challenge') {
          // Respond with a connect request frame (protocol v3 format)
          const connectReq = {
            type: 'req',
            id: randomUUID(),
            method: 'connect',
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: 'kolb-bot-control-ui',
                displayName: 'Kolb-Bot Portal',
                version: '1.0.0',
                platform: 'linux',
                mode: 'ui',
              },
              scopes: ['operator.read', 'operator.admin'],
              auth: { token: GATEWAY_TOKEN },
            },
          };
          this.ws.send(JSON.stringify(connectReq));
          return;
        }
        // Dispatch to listeners
        this.listeners.forEach(fn => { try { fn(msg); } catch {} });
        return;
      }

      // Connect response (hello-ok equivalent in v3 protocol)
      if (msg.type === 'res' && !this.ready) {
        if (msg.ok) {
          this.ready = true;
          this.helloOk = msg.payload || msg;
          console.log(`[GW] Connected to kolb-bot gateway (protocol v${msg.payload?.protocol || PROTOCOL_VERSION})`);
        } else {
          console.error(`[GW] Connect rejected:`, msg.error);
        }
        return;
      }

      // RPC response
      if (msg.type === 'res') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.payload);
        } else {
          p.reject(new Error(msg.error?.message || 'Gateway error: ' + JSON.stringify(msg.error)));
        }
      }
    });

    this.ws.on('close', () => {
      this.ready = false;
      this.helloOk = null;
      console.log('[GW] Disconnected from kolb-bot gateway, reconnecting...');
      // Reject all pending calls
      this.pending.forEach((p, id) => {
        clearTimeout(p.timer);
        p.reject(new Error('Gateway disconnected'));
      });
      this.pending.clear();
      setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on('error', (err) => {
      // Will trigger close handler; just suppress the unhandled error
    });
  }

  /**
   * Call a gateway method. Returns a promise resolving to the payload.
   */
  call(method, params) {
    if (!this.ready) {
      return Promise.reject(new Error('Gateway not connected'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway call '${method}' timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params: params || {} }));
    });
  }

  /**
   * Subscribe to gateway events. Returns unsubscribe function.
   */
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get isConnected() {
    return this.ready;
  }

  get serverInfo() {
    return this.helloOk?.server || null;
  }

  get availableMethods() {
    return this.helloOk?.features?.methods || [];
  }
}

export const gatewayClient = new GatewayClient();
