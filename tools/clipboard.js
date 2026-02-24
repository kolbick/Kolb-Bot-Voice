import clipboardy from 'clipboardy';
import { z } from 'zod';

export function registerClipboardTools(server) {
  server.tool(
    'get_clipboard',
    'Read the current clipboard contents.',
    {},
    async () => {
      try {
        const text = await clipboardy.read();
        return { content: [{ type: 'text', text: text || '(clipboard is empty)' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Clipboard read failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'set_clipboard',
    'Write text to the clipboard.',
    { text: z.string().describe('Text to copy to clipboard') },
    async ({ text }) => {
      try {
        await clipboardy.write(text);
        return { content: [{ type: 'text', text: `Copied ${text.length} chars to clipboard.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Clipboard write failed: ${err.message}` }], isError: true };
      }
    }
  );
}
