import { chromium } from 'playwright';
import { z } from 'zod';

let browser = null;
let context = null;
let page = null;

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
  }
  return page;
}

export function registerPlaywrightTools(server) {
  server.tool(
    'browser_navigate',
    'Navigate the browser to a URL.',
    { url: z.string().describe('URL to navigate to') },
    async ({ url }) => {
      try {
        const p = await ensureBrowser();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { content: [{ type: 'text', text: `Navigated to ${p.url()}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Navigation failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_click',
    'Click an element on the page by CSS selector.',
    { selector: z.string().describe('CSS selector of the element to click') },
    async ({ selector }) => {
      try {
        const p = await ensureBrowser();
        await p.click(selector, { timeout: 5000 });
        return { content: [{ type: 'text', text: `Clicked: ${selector}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Click failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_type',
    'Type text into an element on the page.',
    {
      selector: z.string().describe('CSS selector of the input element'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear the field first (default: true)'),
    },
    async ({ selector, text, clear }) => {
      try {
        const p = await ensureBrowser();
        if (clear !== false) {
          await p.fill(selector, text, { timeout: 5000 });
        } else {
          await p.type(selector, text, { timeout: 5000 });
        }
        return { content: [{ type: 'text', text: `Typed into ${selector}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Type failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_screenshot',
    'Take a screenshot of the current browser page. Returns base64-encoded PNG.',
    {},
    async () => {
      try {
        const p = await ensureBrowser();
        const buf = await p.screenshot({ type: 'png' });
        return {
          content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Screenshot failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_get_content',
    'Get the text content or HTML of the current page.',
    { format: z.string().optional().describe('"text" for inner text, "html" for full HTML (default: text)') },
    async ({ format }) => {
      try {
        const p = await ensureBrowser();
        let content;
        if (format === 'html') {
          content = await p.content();
        } else {
          content = await p.innerText('body');
        }
        if (content.length > 50000) {
          content = content.slice(0, 50000) + '\n... (truncated)';
        }
        return { content: [{ type: 'text', text: content }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Get content failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_evaluate',
    'Execute JavaScript in the browser page and return the result.',
    { script: z.string().describe('JavaScript code to evaluate in the page context') },
    async ({ script }) => {
      try {
        const p = await ensureBrowser();
        const result = await p.evaluate(script);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) ?? 'undefined' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Evaluate failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_scroll',
    'Scroll the page up or down.',
    {
      direction: z.string().describe('"up" or "down"'),
      amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
    },
    async ({ direction, amount }) => {
      try {
        const p = await ensureBrowser();
        const px = amount || 500;
        const delta = direction === 'up' ? -px : px;
        await p.mouse.wheel(0, delta);
        return { content: [{ type: 'text', text: `Scrolled ${direction} by ${px}px` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Scroll failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'browser_back',
    'Navigate the browser back one page.',
    {},
    async () => {
      try {
        const p = await ensureBrowser();
        await p.goBack({ timeout: 10000 });
        return { content: [{ type: 'text', text: `Went back to ${p.url()}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Back navigation failed: ${err.message}` }], isError: true };
      }
    }
  );
}
