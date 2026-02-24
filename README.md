# Kolb-Bot Voice — MCP Server & Portal

The brain behind Kolb-Bot Voice. This is the server that runs on your computer and lets the AI see your screen, control your browser, run commands, and more. It also comes with a built-in web portal where you can chat, make voice calls, and see everything that's connected.

---

## What's in here?

| Piece | What it does |
|---|---|
| **MCP Server** | The tool server the AI talks to — gives it powers like taking screenshots, browsing the web, running commands, etc. |
| **Web Portal** | A web page you can open in your browser to chat with the AI, make voice calls, and manage channels, models, and sessions |
| **Relay** | A bridge that forwards AI tool calls from the cloud down to whatever computer is running the desktop app |
| **Gateway Integration** | Connects to the Kolb-Bot daemon running on this machine so the portal can see live system info |

---

## How to set it up

### Step 1 — Make sure you have Node.js

Open a terminal and run:

```
node --version
```

If you see a version number (like `v22.0.0`) you're good. If not, download Node.js from **[nodejs.org](https://nodejs.org)** and install it.

### Step 2 — Install dependencies

In the terminal, go to this folder and run:

```
npm install
```

Then install the browser Playwright uses:

```
npx playwright install chromium
```

### Step 3 — Set up cloudflared (so ElevenLabs can reach the server)

Download the `cloudflared` tool:

```
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/bin/cloudflared
chmod +x ~/bin/cloudflared
```

> **On Mac?** Use `cloudflared-darwin-amd64` instead of `cloudflared-linux-amd64`
> **On Windows?** Download `cloudflared-windows-amd64.exe` and put it somewhere on your PATH

### Step 4 — Start everything

Run the start script:

```
bash start.sh
```

This starts the MCP server **and** a cloudflared tunnel at the same time. You'll see a line like:

```
https://some-random-words.trycloudflare.com
```

**Copy that URL — you'll need it in the next step.**

### Step 5 — Open the portal

Once the server is running, open your browser and go to:

```
http://localhost:8787/app
```

Or use the cloudflared URL from the previous step:

```
https://your-tunnel-url.trycloudflare.com/app
```

---

## Setting up the desktop app (so the AI can control your PC)

The MCP server by itself doesn't control your computer directly. You also need the **Kolb-Bot Voice desktop app** running on the PC you want the AI to control.

1. Download the desktop app from the [Kolb-Bot-Voice releases page](https://github.com/kolbick/Kolb-Bot-Voice/releases)
2. Open the app — it will ask for a **Relay URL**
3. Paste in your cloudflared tunnel URL with `/relay` at the end:
   ```
   wss://your-tunnel-url.trycloudflare.com/relay
   ```
4. Click **Save & Reconnect**

The portal will show **Tools Connected** when the desktop app is linked up.

> **The relay URL changes every time you restart the server** (because cloudflared gives a new random URL). Just update the desktop app's settings when that happens.

---

## The portal — what each tab does

| Tab | What's there |
|---|---|
| **Chat** | Talk to the AI by typing — choose which AI provider and model to use |
| **Call** | Voice call with the AI — uses ElevenLabs for real-time conversation |
| **Channels** | See all the messaging channels Kolb-Bot is connected to (Discord, etc.) |
| **Models** | See which AI models are available and configured |
| **Agents** | List of AI agents set up in Kolb-Bot |
| **Sessions** | Active and recent conversations |
| **Logs** | Live log stream from the Kolb-Bot daemon |
| **Tools** | Shows all the tools the AI can use (screenshot, browser, files, etc.) |
| **Config** | Shows the current server URL and relay URL |

---

## Running it automatically on startup (Linux only)

There's a systemd service file included. To install it:

```
sudo cp voice-agent-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable voice-agent-mcp
sudo systemctl start voice-agent-mcp
```

Check that it's running:

```
sudo systemctl status voice-agent-mcp
```

---

## What can the AI do once everything is connected?

- *"Take a screenshot and tell me what's on my screen"*
- *"Open Google and search for the weather"*
- *"Click the submit button on this page"*
- *"What files are in my Downloads folder?"*
- *"Read the file at ~/Documents/notes.txt"*
- *"Run this command and show me the output"*
- *"Copy this to my clipboard: ..."*
- *"What's my system's memory usage?"*
- *"Send me a desktop notification"*

---

## Troubleshooting

**Portal says "Tools Disconnected"**
The desktop app isn't connected. Make sure it's running and has the right relay URL. If you restarted the server, the URL changed — update the app's settings.

**Portal tabs (Channels, Models, etc.) show nothing**
The Kolb-Bot gateway isn't running or isn't reachable. Make sure Kolb-Bot is running on this machine.

**`bash start.sh` gives a "cloudflared not found" error**
Make sure cloudflared is installed and in your PATH. Try running `cloudflared --version` to check.

**`npm install` fails**
Make sure Node.js is installed and you're in the right folder (`voice-agent-mcp/`).

**Playwright can't launch the browser**
Run `npx playwright install chromium` to install the browser, then try again.

**The tunnel URL keeps changing**
That's normal for free cloudflared quick tunnels. If you want a permanent URL, set up a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) — it's free and keeps the same address forever.
