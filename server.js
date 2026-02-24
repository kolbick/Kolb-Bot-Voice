import { createServer } from 'http';
import { createReadStream, existsSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = join(__dirname, '..', 'voice-agent-electron', 'release');

// GitHub repo for release downloads (set after repo is created)
const GITHUB_REPO = process.env.GITHUB_REPO || 'kolbick/Kolb-Bot-Voice';

// Cache latest GitHub release info (5 min TTL)
let ghReleaseCache = { data: null, at: 0 };
async function getLatestRelease() {
  if (!GITHUB_REPO) return null;
  if (Date.now() - ghReleaseCache.at < 5 * 60 * 1000) return ghReleaseCache.data;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'voice-agent-mcp' },
    });
    if (!res.ok) return null;
    ghReleaseCache.data = await res.json();
    ghReleaseCache.at = Date.now();
    return ghReleaseCache.data;
  } catch { return null; }
}

function ghAssetUrl(release, ext, exclude) {
  if (!release?.assets) return null;
  const asset = release.assets.find(a => a.name.endsWith(ext) && (!exclude || !a.name.includes(exclude)));
  return asset ? asset.browser_download_url : null;
}
import { gatewayClient } from './gateway-client.js';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerRelayTools } from './tools/relay.js';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8787;

// === Relay state ===
// Tracks the single connected Electron desktop client.
// All MCP tool calls are forwarded to this client for local execution.
const relay = {
  client: null,
  pending: new Map(), // id -> { resolve, reject, timeout }

  call(tool, params) {
    if (!relay.client || relay.client.readyState !== 1 /* OPEN */) {
      return Promise.resolve({
        content: [{
          type: 'text',
          text: 'No desktop client connected. Please open the voice-agent-electron app on your PC.',
        }],
        isError: true,
      });
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        relay.pending.delete(id);
        reject(new Error(`Tool '${tool}' timed out after 30s`));
      }, 30000);
      relay.pending.set(id, { resolve, reject, timeout });
      relay.client.send(JSON.stringify({ id, tool, params: params || {} }));
    });
  },
};

// === MCP server factory ===
// Latest frames pushed from the phone
const phoneCamera = { frame: null, ts: null };
const phoneScreen = { frame: null, ts: null };

function createMcpServer() {
  const server = new McpServer({ name: 'voice-agent-mcp', version: '1.0.0' });
  registerRelayTools(server, (tool, params) => relay.call(tool, params));

  // Server-side tool — reads the frame the phone sent, no relay needed
  server.tool(
    'capture_phone_camera',
    'Capture the current view from the user\'s phone camera. Returns a base64 image of what the phone camera sees right now.',
    {},
    async () => {
      if (!phoneCamera.frame) {
        return { content: [{ type: 'text', text: 'No phone camera frame available. Ask the user to enable their camera in the app.' }], isError: true };
      }
      const age = Math.round((Date.now() - phoneCamera.ts) / 1000);
      return {
        content: [
          { type: 'text', text: `Phone camera frame captured ${age}s ago.` },
          { type: 'image', data: phoneCamera.frame, mimeType: 'image/jpeg' },
        ],
      };
    }
  );

  server.tool(
    'capture_phone_screen',
    'Capture the current browser tab on the user\'s iPhone. Returns a base64 image of what is visible on their screen right now.',
    {},
    async () => {
      if (!phoneScreen.frame) {
        return { content: [{ type: 'text', text: 'No phone screen frame available. Ask the user to tap "Share Screen" in the app.' }], isError: true };
      }
      const age = Math.round((Date.now() - phoneScreen.ts) / 1000);
      return {
        content: [
          { type: 'text', text: `Phone screen frame captured ${age}s ago.` },
          { type: 'image', data: phoneScreen.frame, mimeType: 'image/jpeg' },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path === '/') return next();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} session=${req.headers['mcp-session-id'] || 'none'}`);
  if (req.body && req.body.method) {
    console.log(`  -> ${req.body.method} id=${req.body.id || 'notification'}`);
  }
  next();
});

const sessions = new Map();
const sseTransports = new Map();

// Health check API
app.get('/api/status', (req, res) => {
  res.json({
    name: 'voice-agent-mcp',
    status: 'running',
    activeSessions: sessions.size + sseTransports.size,
    relayConnected: relay.client !== null && relay.client.readyState === 1,
  });
});

// Root → portal
app.get('/', (req, res) => res.redirect('/app'));

// === Download page ===

function getBuilds() {
  if (!existsSync(RELEASE_DIR)) return { linux: null, win: null, winExt: null };
  const entries = readdirSync(RELEASE_DIR);
  const winExe = entries.find(f => f.endsWith('.exe')) || null;
  const winZip = entries.find(f => f.endsWith('.zip') && f.toLowerCase().includes('windows')) || null;
  return {
    linux: entries.find(f => f.endsWith('.AppImage')) || null,
    win: winExe || winZip,
    winExt: winExe ? '.exe' : winZip ? '.zip' : null,
  };
}

app.get('/download', async (req, res) => {
  // Auto-detect public URL from request headers — works through cloudflared
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  const relayUrl = `${wsProto}://${host}/relay`;
  const appUrl = `${proto}://${host}/app`;

  // Prefer GitHub release URLs, fall back to local builds
  const release = await getLatestRelease();
  const local = getBuilds();

  const linuxUrl = ghAssetUrl(release, '.AppImage') || (local.linux ? '/download/linux' : null);
  const winUrl = ghAssetUrl(release, '.exe') || ghAssetUrl(release, '.zip') || (local.win ? '/download/win' : null);
  const macUrlIntel = ghAssetUrl(release, '.dmg', 'arm64');
  const macUrlArm64 = ghAssetUrl(release, 'arm64.dmg');
  const macUrl = macUrlIntel || macUrlArm64;
  const { winExt } = local;

  const dlBtn = (href, cls, icon, label) =>
    '<a class="dl-btn ' + cls + '" href="' + href + '">' + icon + ' ' + label + '</a>';
  const disabledBtn = (label) =>
    '<span class="dl-btn btn-disabled">' + label + '</span>';

  const linuxIcon = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12.5 2C8.36 2 5 5.36 5 9.5c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h7c.55 0 1-.45 1-1v-1.76c1.81-1.27 3-3.36 3-5.74C20 5.36 16.64 2 12.5 2zM9 20h6v1H9v-1zm1-4h4v1h-4v-1zm2-12c2.76 0 5 2.24 5 5s-2.24 5-5 5-5-2.24-5-5 2.24-5 5-5z"/></svg>';
  const winIcon = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M3 12V6.75l6-1.32V12H3zm6.75 0V5.2L21 3v9H9.75zM3 13h6v5.43L3 17.25V13zm6.75 0H21v9L9.75 20.55V13z"/></svg>';
  const macIcon = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kolb-Bot — AI Voice Agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
<style>
:root{--pd:#3B0764;--pp:#7C3AED;--pm:#9333EA;--pl:#F5F3FF;--pb:#DDD6FE;--go:#B45309;--gb:#FFFBEB;--gbd:#FDE68A;--tx:#111827;--mu:#6B7280;--bg:#F9FAFB;--sf:#fff;--br:#E5E7EB;--r:12px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--tx);min-height:100vh}

nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.94);backdrop-filter:blur(14px);border-bottom:1px solid var(--br);padding:0 28px;display:flex;align-items:center;justify-content:space-between;height:62px}
.nav-brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.nav-brand img{width:36px;height:36px;border-radius:8px}
.nav-name{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;letter-spacing:1.5px;color:var(--pd)}
.nav-links{display:flex;align-items:center;gap:8px}
.nav-link{color:var(--mu);font-size:14px;font-weight:500;text-decoration:none;padding:6px 12px;border-radius:8px;transition:color .15s}
.nav-link:hover{color:var(--pp)}
.nav-cta{background:var(--pp);color:#fff;padding:9px 20px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:600;transition:background .15s,transform .12s}
.nav-cta:hover{background:var(--pm);transform:translateY(-1px)}

.hero{display:grid;grid-template-columns:1fr 1fr;min-height:calc(100vh - 62px);max-width:1180px;margin:0 auto;padding:0 28px;align-items:center;gap:32px}
.hero-left{padding:60px 0}
.badge{display:inline-flex;align-items:center;gap:7px;background:var(--gb);border:1px solid var(--gbd);color:var(--go);font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 13px;border-radius:20px;margin-bottom:22px}
.badge-dot{width:6px;height:6px;background:var(--go);border-radius:50%;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
h1{font-family:'Barlow Condensed',sans-serif;font-size:clamp(60px,7.5vw,100px);font-weight:800;line-height:.92;letter-spacing:-1px;color:var(--pd);margin-bottom:22px}
h1 em{color:var(--pp);font-style:normal}
.hero-sub{font-size:17px;color:var(--mu);line-height:1.65;max-width:420px;margin-bottom:36px}
.widget-card{background:var(--sf);border:1px solid var(--br);border-radius:16px;padding:20px 20px 16px;box-shadow:0 4px 28px rgba(124,58,237,.1);max-width:420px}
.widget-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--mu);margin-bottom:12px;display:flex;align-items:center;gap:6px}
.widget-label::before{content:'';width:7px;height:7px;background:#22c55e;border-radius:50%;animation:pulse 2s ease-in-out infinite}

.hero-right{display:flex;align-items:center;justify-content:center;position:relative;padding:40px 0}
.mascot-glow{position:absolute;width:380px;height:380px;background:radial-gradient(circle,rgba(124,58,237,.16) 0%,transparent 68%);border-radius:50%;top:50%;left:50%;transform:translate(-50%,-50%)}
.mascot-img{position:relative;z-index:1;height:min(72vh,580px);width:auto;object-fit:contain;animation:float 5s ease-in-out infinite;filter:drop-shadow(0 28px 48px rgba(59,7,100,.2))}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}

.dl-section{background:var(--pd);padding:88px 28px}
.dl-inner{max-width:700px;margin:0 auto}
.sec-label{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:10px}
.sec-title{font-family:'Barlow Condensed',sans-serif;font-size:clamp(40px,5.5vw,62px);font-weight:800;color:#fff;line-height:.95;margin-bottom:18px}
.sec-desc{font-size:16px;color:rgba(255,255,255,.6);line-height:1.65;margin-bottom:44px;max-width:540px}

.relay-card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:var(--r);padding:20px 24px;margin-bottom:28px}
.relay-label{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:12px;display:flex;align-items:center;gap:7px}
.relay-row{display:flex;align-items:center;gap:10px}
.relay-url{flex:1;font-family:'Courier New',monospace;font-size:13px;color:#86efac;word-break:break-all;cursor:pointer;padding:10px 14px;background:rgba(0,0,0,.25);border-radius:8px;border:1px solid rgba(134,239,172,.18);transition:border-color .15s;user-select:all}
.relay-url:hover{border-color:rgba(134,239,172,.45)}
.copy-btn{white-space:nowrap;padding:10px 16px;border-radius:8px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s;display:flex;align-items:center;gap:6px;font-family:'DM Sans',sans-serif}
.copy-btn:hover{background:rgba(255,255,255,.18)}
.copy-btn.ok{background:rgba(134,239,172,.18);border-color:rgba(134,239,172,.35);color:#86efac}

.platform-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}
.dl-btn{display:inline-flex;align-items:center;gap:9px;padding:13px 20px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;transition:transform .12s,box-shadow .12s;border:none;cursor:pointer;white-space:nowrap;font-family:'DM Sans',sans-serif}
.dl-btn:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.btn-linux{background:#7C3AED;color:#fff}
.btn-linux:hover{background:#9333EA}
.btn-win{background:#0078D4;color:#fff}
.btn-win:hover{background:#106EBE}
.btn-mac{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2)!important}
.btn-mac:hover{background:rgba(255,255,255,.2)}
.btn-disabled{background:rgba(255,255,255,.05);color:rgba(255,255,255,.28);cursor:default;border:1px solid rgba(255,255,255,.08)!important}
.btn-disabled:hover{transform:none;box-shadow:none}

.ios-card{display:flex;align-items:center;gap:14px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.28);border-radius:var(--r);padding:16px 20px;margin-bottom:40px}
.ios-card img{width:44px;height:44px;border-radius:10px;flex-shrink:0}
.ios-card strong{display:block;color:#FCD34D;font-size:14px;margin-bottom:2px}
.ios-card a{color:rgba(255,255,255,.7);font-size:13px;text-decoration:none;transition:color .15s}
.ios-card a:hover{color:#fff}
.ios-card span{font-size:12px;color:rgba(255,255,255,.38);display:block;margin-top:2px}

.steps-title{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:14px}
.steps{display:flex;flex-direction:column;gap:10px}
.step{display:flex;align-items:flex-start;gap:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px 16px}
.step-num{width:26px;height:26px;border-radius:50%;background:var(--pp);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step p{font-size:14px;color:rgba(255,255,255,.6);line-height:1.55}
.step p strong{color:rgba(255,255,255,.9)}
code{font-family:'Courier New',monospace;font-size:12px;background:rgba(0,0,0,.3);color:#86efac;padding:2px 7px;border-radius:4px}

@media(max-width:800px){
  .hero{grid-template-columns:1fr;min-height:auto;padding:28px 20px;gap:0}
  .hero-right{display:none}
  .hero-left{padding:32px 0}
  .dl-section{padding:60px 20px}
  nav{padding:0 20px}
}
</style>
</head>
<body>

<nav>
  <a href="/" class="nav-brand">
    <img src="/apple-touch-icon.png" alt="Kolb-Bot">
    <span class="nav-name">KOLB-BOT</span>
  </a>
  <div class="nav-links">
    <a href="${appUrl}" class="nav-link">iPhone App</a>
    <a href="#download" class="nav-cta">Download</a>
  </div>
</nav>

<section class="hero">
  <div class="hero-left">
    <div class="badge"><span class="badge-dot"></span>Powered by ElevenLabs</div>
    <h1>YOUR AI<br><em>VOICE</em><br>AGENT</h1>
    <p class="hero-sub">Control your entire computer hands-free — screen capture, browser, files, clipboard, shell commands, and more.</p>
    <div class="widget-card">
      <div class="widget-label">Try it now — no download needed</div>
      <elevenlabs-convai agent-id="agent_3201kj2x8772fyxv3et1cptrbyed"></elevenlabs-convai>
    </div>
  </div>
  <div class="hero-right">
    <div class="mascot-glow"></div>
    <img src="/mascot-hero.png" class="mascot-img" alt="Kolb-Bot">
  </div>
</section>

<section class="dl-section" id="download">
  <div class="dl-inner">
    <div class="sec-label">Desktop App</div>
    <h2 class="sec-title">UNLOCK FULL<br>PC CONTROL</h2>
    <p class="sec-desc">The browser widget is great for chatting. The desktop app gives the AI actual control of your machine.</p>

    <div class="relay-card">
      <div class="relay-label">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>
        Relay URL — paste into app on first launch
      </div>
      <div class="relay-row">
        <div class="relay-url" id="relayUrl" onclick="copyRelay()">${relayUrl}</div>
        <button class="copy-btn" id="copyBtn" onclick="copyRelay()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          Copy
        </button>
      </div>
    </div>

    <div class="platform-grid">
      ${linuxUrl ? dlBtn(linuxUrl, 'btn-linux', linuxIcon, 'Linux (.AppImage)') : disabledBtn('Linux — building…')}
      ${winUrl ? dlBtn(winUrl, 'btn-win', winIcon, 'Windows (.exe)') : disabledBtn('Windows — building…')}
      ${macUrlIntel ? dlBtn(macUrlIntel, 'btn-mac', macIcon, 'macOS Intel') : (macUrl ? dlBtn(macUrl, 'btn-mac', macIcon, 'macOS') : disabledBtn('macOS — building…'))}
      ${macUrlArm64 && macUrlIntel ? dlBtn(macUrlArm64, 'btn-mac', macIcon, 'macOS Apple Silicon') : ''}
    </div>

    <div class="ios-card">
      <img src="/apple-touch-icon.png" alt="iOS">
      <div>
        <strong>On iPhone?</strong>
        <a href="${appUrl}">Open the iOS app →</a>
        <span>Add to Home Screen for a full-screen native experience</span>
      </div>
    </div>

    <p class="steps-title">Quick Setup</p>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><p><strong>Install:</strong> Linux: <code>chmod +x Kolb-Bot*.AppImage</code> then run it. Windows: run the installer. Mac: open .dmg and drag to Applications.</p></div>
      <div class="step"><div class="step-num">2</div><p><strong>Connect:</strong> On first launch a Settings screen appears — paste the <strong>Relay URL</strong> above and click Save &amp; Reconnect.</p></div>
      <div class="step"><div class="step-num">3</div><p><strong>Talk:</strong> Press Talk and start speaking. The AI hears you, responds, and controls your computer.</p></div>
    </div>
  </div>
</section>

<script src="https://unpkg.com/@elevenlabs/convai-widget-embed" async type="text/javascript"></script>
<script>
function copyRelay() {
  const url = document.getElementById('relayUrl').textContent.trim();
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.classList.add('ok');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Copied!';
    setTimeout(() => {
      btn.classList.remove('ok');
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy';
    }, 2500);
  });
}
</script>
</body>
</html>`);
});

// Serve built release files
app.get('/download/linux', (req, res) => {
  const { linux } = getBuilds();
  if (!linux) return res.status(404).send('Linux build not found. Run: cd voice-agent-electron && npm run package:linux');
  const filePath = join(RELEASE_DIR, linux);
  res.setHeader('Content-Disposition', 'attachment; filename="Kolb-Bot-Voice.AppImage"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', statSync(filePath).size);
  createReadStream(filePath).pipe(res);
});

app.get('/download/win', (req, res) => {
  const { win, winExt } = getBuilds();
  if (!win) return res.status(404).send('Windows build not found. Run: cd voice-agent-electron && npm run package:win');
  const filePath = join(RELEASE_DIR, win);
  const dlName = winExt === '.exe' ? 'Kolb-Bot-Voice-Setup.exe' : 'Kolb-Bot-Voice-Windows.zip';
  const mime = winExt === '.zip' ? 'application/zip' : 'application/octet-stream';
  res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', statSync(filePath).size);
  createReadStream(filePath).pipe(res);
});

// === Kolb-Bot Gateway API routes ===

app.get('/api/kb/status', async (req, res) => {
  try {
    const payload = await gatewayClient.call('status', {});
    res.json({ ok: true, connected: gatewayClient.isConnected, server: gatewayClient.serverInfo, ...payload });
  } catch (e) {
    res.json({ ok: false, connected: false, error: e.message });
  }
});

app.get('/api/kb/channels', async (req, res) => {
  try {
    const payload = await gatewayClient.call('channels.status', {});
    res.json({ ok: true, ...payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get('/api/kb/models', async (req, res) => {
  try {
    const payload = await gatewayClient.call('models.list', {});
    res.json({ ok: true, ...payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get('/api/kb/agents', async (req, res) => {
  try {
    const payload = await gatewayClient.call('agents.list', {});
    res.json({ ok: true, ...payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get('/api/kb/sessions', async (req, res) => {
  try {
    const payload = await gatewayClient.call('sessions.list', {});
    res.json({ ok: true, ...payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.delete('/api/kb/sessions/:key', async (req, res) => {
  try {
    const payload = await gatewayClient.call('sessions.delete', { key: req.params.key });
    res.json({ ok: true, ...payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get('/api/kb/logs', async (req, res) => {
  try {
    const payload = await gatewayClient.call('logs.tail', { count: parseInt(req.query.count) || 200 });
    res.json({ ok: true, ...payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// Chat via gateway OpenAI-compatible endpoint (preferred over direct provider proxy)
app.post('/api/kb/chat', express.json({ limit: '1mb' }), async (req, res) => {
  const { messages, model } = req.body;
  try {
    const r = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'kolb-bot', messages, stream: false }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Gateway chat error' });
    res.json({ content: d.choices?.[0]?.message?.content || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generic gateway RPC proxy (for future use by the UI)
app.post('/api/kb/rpc', express.json({ limit: '512kb' }), async (req, res) => {
  const { method, params } = req.body;
  if (!method) return res.status(400).json({ error: 'method required' });
  try {
    const payload = await gatewayClient.call(method, params || {});
    res.json({ ok: true, payload });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// === Config endpoint (dynamic relay URL for portal) ===

app.get('/api/config', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  res.json({ relayUrl: `${wsProto}://${host}/relay`, baseUrl: `${proto}://${host}` });
});

// === Full Portal ===
app.get('/app', (req, res) => res.sendFile('app.html', { root: join(__dirname, 'public') }));




app.get('/manifest.json', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  res.json({
    name: 'Kolb-Bot Voice',
    short_name: 'Kolb-Bot',
    description: 'AI voice assistant',
    start_url: '/app',
    display: 'standalone',
    background_color: '#FAF9F7',
    theme_color: '#FAF9F7',
    orientation: 'portrait',
    icons: [
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: '/icon-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

const PUBLIC_FILES = ['apple-touch-icon.png','icon-1024.png','mascot-hero.png','mascot-square.png',
  'kolb-bot-banner-design.png','kolb-bot-notes.png','kolb-bot-on-pc.png','kolb-bot-tech-support.png'];
PUBLIC_FILES.forEach(f => app.get('/' + f, (req, res) => res.sendFile(f, { root: join(__dirname, 'public') })));

// === Tool definitions (for portal UI) ===
const TOOL_DEFS = [
  { name:'capture_screen', desc:'Full desktop screenshot', cat:'Vision' },
  { name:'capture_region', desc:'Screenshot a specific region', cat:'Vision' },
  { name:'capture_phone_camera', desc:"Live view from user's phone camera", cat:'Vision' },
  { name:'capture_phone_screen', desc:"Capture user's iPhone browser tab", cat:'Vision' },
  { name:'browser_navigate', desc:'Navigate browser to a URL', cat:'Browser' },
  { name:'browser_click', desc:'Click element by CSS selector', cat:'Browser' },
  { name:'browser_type', desc:'Type text into an element', cat:'Browser' },
  { name:'browser_screenshot', desc:'Screenshot current browser page', cat:'Browser' },
  { name:'browser_get_content', desc:'Get text/HTML of current page', cat:'Browser' },
  { name:'browser_evaluate', desc:'Run JavaScript in the browser', cat:'Browser' },
  { name:'browser_scroll', desc:'Scroll the page up or down', cat:'Browser' },
  { name:'browser_back', desc:'Navigate browser back one page', cat:'Browser' },
  { name:'read_file', desc:'Read contents of a file', cat:'Files' },
  { name:'write_file', desc:'Write content to a file', cat:'Files' },
  { name:'list_directory', desc:'List contents of a directory', cat:'Files' },
  { name:'search_files', desc:'Search files by name pattern', cat:'Files' },
  { name:'search_content', desc:'Search text content in files', cat:'Files' },
  { name:'run_command', desc:'Execute a shell command', cat:'Shell' },
  { name:'get_processes', desc:'List running processes', cat:'Shell' },
  { name:'get_clipboard', desc:'Read current clipboard contents', cat:'Clipboard' },
  { name:'set_clipboard', desc:'Write text to clipboard', cat:'Clipboard' },
  { name:'get_system_info', desc:'OS, uptime, memory, disk info', cat:'System' },
  { name:'send_notification', desc:'Send a desktop notification', cat:'System' },
  { name:'get_datetime', desc:'Get current date and time', cat:'System' },
];

app.get('/api/tools', (req, res) => {
  const relayOk = relay.client !== null && relay.client.readyState === 1;
  res.json({ tools: TOOL_DEFS, relayConnected: relayOk });
});

// === Chat proxy ===
app.post('/api/chat', express.json({ limit: '1mb' }), async (req, res) => {
  const { messages, provider, model, apiKey } = req.body;
  try {
    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'gpt-4o', messages }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'OpenAI error' });
      return res.json({ content: d.choices[0].message.content });

    } else if (provider === 'anthropic') {
      const sys = messages.find(m => m.role === 'system');
      const chat = messages.filter(m => m.role !== 'system');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-6', messages: chat, max_tokens: 4096, ...(sys ? { system: sys.content } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Anthropic error' });
      return res.json({ content: d.content[0].text });

    } else if (provider === 'gemini') {
      const chat = messages.filter(m => m.role !== 'system');
      const contents = chat.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Gemini error' });
      return res.json({ content: d.candidates[0].content.parts[0].text });

    } else if (provider === 'ollama') {
      const r = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'llama3.2', messages, stream: false }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'Ollama error' });
      return res.json({ content: d.message.content });

    } else {
      return res.status(400).json({ error: 'Unknown provider: ' + provider });
    }
  } catch (err) {
    console.error('[Chat]', err);
    res.status(500).json({ error: err.message });
  }
});

// Phone camera frame upload
app.post('/camera-frame', express.json({ limit: '2mb' }), (req, res) => {
  const { frame } = req.body;
  if (!frame) return res.status(400).json({ error: 'missing frame' });
  phoneCamera.frame = frame;
  phoneCamera.ts = Date.now();
  res.json({ ok: true });
});

// Phone screen frame upload
app.post('/screen-frame', express.json({ limit: '2mb' }), (req, res) => {
  const { frame } = req.body;
  if (!frame) return res.status(400).json({ error: 'missing frame' });
  phoneScreen.frame = frame;
  phoneScreen.ts = Date.now();
  res.json({ ok: true });
});
// === Streamable HTTP transport on /mcp ===

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    transport.onerror = (err) => console.error('[MCP] Transport error:', err);
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      console.log(`[MCP] Session created: ${newSessionId}`);
      sessions.set(newSessionId, { transport, server });
      transport.onclose = () => {
        console.log(`[MCP] Session ended: ${newSessionId}`);
        sessions.delete(newSessionId);
      };
    }
  } catch (err) {
    console.error('[MCP] POST error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'No valid session.' });
    }
  } catch (err) {
    console.error('[MCP] GET error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.delete('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
      sessions.delete(sessionId);
    } else {
      res.status(404).json({ error: 'Session not found.' });
    }
  } catch (err) {
    console.error('[MCP] DELETE error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// === SSE transport on /sse + /messages ===

app.get('/sse', async (req, res) => {
  console.log('[SSE] New client connected');
  const transport = new SSEServerTransport('/messages', res);
  const sid = transport.sessionId;
  sseTransports.set(sid, transport);
  res.on('close', () => {
    console.log(`[SSE] Client disconnected: ${sid}`);
    sseTransports.delete(sid);
  });
  const server = createMcpServer();
  await server.connect(transport);
  console.log(`[SSE] Session established: ${sid}`);
});

app.post('/messages', async (req, res) => {
  const sid = req.query.sessionId;
  const transport = sseTransports.get(sid);
  if (!transport) return res.status(400).json({ error: 'Unknown session.' });
  await transport.handlePostMessage(req, res);
});

// === HTTP server + WebSocket relay on /relay ===

const httpServer = createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: '/relay' });
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[Relay] Desktop client connected from ${clientIp}`);
  relay.client = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const pending = relay.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        relay.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch (err) {
      console.error('[Relay] Message parse error:', err);
    }
  });

  ws.on('close', () => {
    if (relay.client === ws) relay.client = null;
    console.log('[Relay] Desktop client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[Relay] WebSocket error:', err.message);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice Agent MCP server running on http://0.0.0.0:${PORT}`);
  console.log(`  Streamable: http://localhost:${PORT}/mcp`);
  console.log(`  SSE:        http://localhost:${PORT}/sse`);
  console.log(`  Relay WS:   ws://localhost:${PORT}/relay`);
});
