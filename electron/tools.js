import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve } from 'path';
import { Notification } from 'electron';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Lazy imports for optional heavy deps
let screenshotDesktop = null;
let clipboardy = null;
let playwright = null;
let browser = null, pwContext = null, pwPage = null;

async function getScreenshot() {
  if (!screenshotDesktop) screenshotDesktop = (await import('screenshot-desktop')).default;
  return screenshotDesktop;
}

async function getClipboard() {
  if (!clipboardy) clipboardy = await import('clipboardy');
  return clipboardy;
}

async function ensureBrowser() {
  if (!playwright) playwright = await import('playwright');
  const { chromium } = playwright;
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: false });
    pwContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    pwPage = await pwContext.newPage();
  }
  if (!pwPage || pwPage.isClosed()) {
    pwPage = await pwContext.newPage();
  }
  return pwPage;
}

export async function executeTool(name, params = {}) {
  switch (name) {

    // --- Vision ---
    case 'capture_screen': {
      const screenshot = await getScreenshot();
      const img = await screenshot({ format: 'png' });
      return { content: [{ type: 'image', data: img.toString('base64'), mimeType: 'image/png' }] };
    }

    case 'capture_region': {
      const { x, y, width, height } = params;
      const screenshot = await getScreenshot();
      const img = await screenshot({ format: 'png' });
      try {
        const sharp = (await import('sharp')).default;
        const cropped = await sharp(img).extract({ left: x, top: y, width, height }).png().toBuffer();
        return { content: [{ type: 'image', data: cropped.toString('base64'), mimeType: 'image/png' }] };
      } catch {
        return {
          content: [
            { type: 'image', data: img.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `Note: Region cropping unavailable (install sharp). Returning full screenshot.` },
          ],
        };
      }
    }

    // --- Playwright ---
    case 'browser_navigate': {
      const p = await ensureBrowser();
      await p.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { content: [{ type: 'text', text: `Navigated to ${p.url()}` }] };
    }

    case 'browser_click': {
      const p = await ensureBrowser();
      await p.click(params.selector, { timeout: 5000 });
      return { content: [{ type: 'text', text: `Clicked: ${params.selector}` }] };
    }

    case 'browser_type': {
      const p = await ensureBrowser();
      if (params.clear !== false) {
        await p.fill(params.selector, params.text, { timeout: 5000 });
      } else {
        await p.type(params.selector, params.text, { timeout: 5000 });
      }
      return { content: [{ type: 'text', text: `Typed into ${params.selector}` }] };
    }

    case 'browser_screenshot': {
      const p = await ensureBrowser();
      const buf = await p.screenshot({ type: 'png' });
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] };
    }

    case 'browser_get_content': {
      const p = await ensureBrowser();
      let content;
      if (params.format === 'html') {
        content = await p.content();
      } else {
        content = await p.innerText('body');
      }
      if (content.length > 50000) content = content.slice(0, 50000) + '\n... (truncated)';
      return { content: [{ type: 'text', text: content }] };
    }

    case 'browser_evaluate': {
      const p = await ensureBrowser();
      const result = await p.evaluate(params.script);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) ?? 'undefined' }] };
    }

    case 'browser_scroll': {
      const p = await ensureBrowser();
      const px = params.amount || 500;
      await p.mouse.wheel(0, params.direction === 'up' ? -px : px);
      return { content: [{ type: 'text', text: `Scrolled ${params.direction} by ${px}px` }] };
    }

    case 'browser_back': {
      const p = await ensureBrowser();
      await p.goBack({ timeout: 10000 });
      return { content: [{ type: 'text', text: `Went back to ${p.url()}` }] };
    }

    // --- Filesystem ---
    case 'read_file': {
      const resolved = resolve(params.path);
      const content = await readFile(resolved, 'utf-8');
      const text = content.length > 100000 ? content.slice(0, 100000) + '\n... (truncated at 100k chars)' : content;
      return { content: [{ type: 'text', text }] };
    }

    case 'write_file': {
      const resolved = resolve(params.path);
      await writeFile(resolved, params.content, 'utf-8');
      return { content: [{ type: 'text', text: `Wrote ${params.content.length} chars to ${resolved}` }] };
    }

    case 'list_directory': {
      const resolved = resolve(params.path || '.');
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = entries.map((e) => {
        const type = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
        return `[${type}] ${e.name}`;
      });
      return { content: [{ type: 'text', text: `${resolved}/\n${lines.join('\n')}` }] };
    }

    case 'search_files': {
      const dir = resolve(params.directory || process.env.HOME);
      const { stdout } = await execFileAsync('find', [
        dir, '-maxdepth', String(params.max_depth || 5), '-name', params.pattern, '-type', 'f',
      ], { timeout: 10000 });
      return { content: [{ type: 'text', text: stdout.trim() || 'No files found.' }] };
    }

    case 'search_content': {
      const dir = resolve(params.directory || '.');
      const args = ['-r', '-n', '-l', '--max-count=50'];
      if (params.file_pattern) args.push('--include', params.file_pattern);
      args.push(params.pattern, dir);
      try {
        const { stdout } = await execFileAsync('grep', args, { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout.trim() || 'No matches found.' }] };
      } catch (err) {
        if (err.code === 1) return { content: [{ type: 'text', text: 'No matches found.' }] };
        throw err;
      }
    }

    // --- Shell ---
    case 'run_command': {
      try {
        const { stdout, stderr } = await execAsync(params.command, {
          timeout: params.timeout || 30000,
          cwd: params.cwd || process.env.HOME,
          maxBuffer: 1024 * 1024,
          shell: '/bin/bash',
        });
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (!output) output = '(no output)';
        if (output.length > 50000) output = output.slice(0, 50000) + '\n... (truncated)';
        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        let msg = err.message;
        if (err.stdout) msg += '\n--- stdout ---\n' + err.stdout;
        if (err.stderr) msg += '\n--- stderr ---\n' + err.stderr;
        return { content: [{ type: 'text', text: `Command failed: ${msg}` }], isError: true };
      }
    }

    case 'get_processes': {
      const cmd = params.filter
        ? `ps aux | head -1; ps aux | grep -i '${params.filter.replace(/'/g, "\\'")}' | grep -v grep`
        : 'ps aux --sort=-%mem | head -30';
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      return { content: [{ type: 'text', text: stdout.trim() }] };
    }

    // --- Clipboard ---
    case 'get_clipboard': {
      const clip = await getClipboard();
      const text = await clip.default.read();
      return { content: [{ type: 'text', text: text || '(clipboard is empty)' }] };
    }

    case 'set_clipboard': {
      const clip = await getClipboard();
      await clip.default.write(params.text);
      return { content: [{ type: 'text', text: `Copied ${params.text.length} chars to clipboard.` }] };
    }

    // --- System ---
    case 'get_system_info': {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      let diskInfo = '';
      try {
        const { stdout } = await execAsync('df -h / | tail -1', { timeout: 3000 });
        diskInfo = stdout.trim();
      } catch {}
      const info = [
        `Hostname: ${os.hostname()}`,
        `OS: ${os.type()} ${os.release()} (${os.arch()})`,
        `Uptime: ${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
        `CPUs: ${os.cpus().length} cores`,
        `Memory: ${(usedMem / 1e9).toFixed(1)}GB / ${(totalMem / 1e9).toFixed(1)}GB (${Math.round(usedMem / totalMem * 100)}% used)`,
        `Disk (root): ${diskInfo}`,
        `User: ${os.userInfo().username}`,
        `Home: ${os.homedir()}`,
      ].join('\n');
      return { content: [{ type: 'text', text: info }] };
    }

    case 'send_notification': {
      const n = new Notification({ title: params.title, body: params.message });
      n.show();
      return { content: [{ type: 'text', text: `Notification sent: "${params.title}"` }] };
    }

    case 'get_datetime': {
      const now = new Date();
      return {
        content: [{
          type: 'text',
          text: [
            `Date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
            `Time: ${now.toLocaleTimeString('en-US')}`,
            `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
            `ISO: ${now.toISOString()}`,
          ].join('\n'),
        }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
