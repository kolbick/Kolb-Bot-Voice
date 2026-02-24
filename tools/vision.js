import screenshot from 'screenshot-desktop';
import { z } from 'zod';

export function registerVisionTools(server) {
  server.tool(
    'capture_screen',
    'Take a full screenshot of the desktop. Returns base64-encoded PNG.',
    {},
    async () => {
      try {
        const img = await screenshot({ format: 'png' });
        return {
          content: [{ type: 'image', data: img.toString('base64'), mimeType: 'image/png' }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Screenshot failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'capture_region',
    'Take a screenshot of a specific region of the desktop.',
    {
      x: z.number().describe('X coordinate of top-left corner'),
      y: z.number().describe('Y coordinate of top-left corner'),
      width: z.number().describe('Width of the region'),
      height: z.number().describe('Height of the region'),
    },
    async ({ x, y, width, height }) => {
      try {
        const img = await screenshot({ format: 'png' });
        try {
          const sharp = (await import('sharp')).default;
          const cropped = await sharp(img).extract({ left: x, top: y, width, height }).png().toBuffer();
          return {
            content: [{ type: 'image', data: cropped.toString('base64'), mimeType: 'image/png' }],
          };
        } catch {
          return {
            content: [
              { type: 'image', data: img.toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: `Note: Region cropping unavailable (install sharp). Returning full screenshot. Requested region: x=${x}, y=${y}, ${width}x${height}` },
            ],
          };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Screenshot failed: ${err.message}` }], isError: true };
      }
    }
  );
}
