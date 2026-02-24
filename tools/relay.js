import { z } from 'zod';

/**
 * Register all tools with a relay executor.
 * Instead of running locally, each tool call is forwarded to
 * the connected Electron client via WebSocket.
 *
 * @param {McpServer} server
 * @param {(tool: string, params: object) => Promise<object>} executor
 */
export function registerRelayTools(server, executor) {
  // --- Vision ---
  server.tool('capture_screen', 'Take a full screenshot of the desktop. Returns base64-encoded PNG.', {}, (p) => executor('capture_screen', p));

  server.tool('capture_region', 'Take a screenshot of a specific region of the desktop.', {
    x: z.number().describe('X coordinate of top-left corner'),
    y: z.number().describe('Y coordinate of top-left corner'),
    width: z.number().describe('Width of the region'),
    height: z.number().describe('Height of the region'),
  }, (p) => executor('capture_region', p));

  // --- Playwright ---
  server.tool('browser_navigate', 'Navigate the browser to a URL.', {
    url: z.string().describe('URL to navigate to'),
  }, (p) => executor('browser_navigate', p));

  server.tool('browser_click', 'Click an element on the page by CSS selector.', {
    selector: z.string().describe('CSS selector of the element to click'),
  }, (p) => executor('browser_click', p));

  server.tool('browser_type', 'Type text into an element on the page.', {
    selector: z.string().describe('CSS selector of the input element'),
    text: z.string().describe('Text to type'),
    clear: z.boolean().optional().describe('Clear the field first (default: true)'),
  }, (p) => executor('browser_type', p));

  server.tool('browser_screenshot', 'Take a screenshot of the current browser page. Returns base64-encoded PNG.', {}, (p) => executor('browser_screenshot', p));

  server.tool('browser_get_content', 'Get the text content or HTML of the current page.', {
    format: z.string().optional().describe('"text" for inner text, "html" for full HTML (default: text)'),
  }, (p) => executor('browser_get_content', p));

  server.tool('browser_evaluate', 'Execute JavaScript in the browser page and return the result.', {
    script: z.string().describe('JavaScript code to evaluate in the page context'),
  }, (p) => executor('browser_evaluate', p));

  server.tool('browser_scroll', 'Scroll the page up or down.', {
    direction: z.string().describe('"up" or "down"'),
    amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
  }, (p) => executor('browser_scroll', p));

  server.tool('browser_back', 'Navigate the browser back one page.', {}, (p) => executor('browser_back', p));

  // --- Filesystem ---
  server.tool('read_file', 'Read the contents of a file.', {
    path: z.string().describe('Absolute or relative path to the file'),
  }, (p) => executor('read_file', p));

  server.tool('write_file', 'Write content to a file. Creates the file if it does not exist.', {
    path: z.string().describe('Absolute or relative path to the file'),
    content: z.string().describe('Content to write'),
  }, (p) => executor('write_file', p));

  server.tool('list_directory', 'List the contents of a directory.', {
    path: z.string().optional().describe('Directory path (default: current directory)'),
  }, (p) => executor('list_directory', p));

  server.tool('search_files', 'Search for files by name pattern using find.', {
    pattern: z.string().describe('File name pattern (glob), e.g. "*.js"'),
    directory: z.string().optional().describe('Directory to search in (default: home)'),
    max_depth: z.number().optional().describe('Max directory depth (default: 5)'),
  }, (p) => executor('search_files', p));

  server.tool('search_content', 'Search for text content within files using grep.', {
    pattern: z.string().describe('Text or regex pattern to search for'),
    directory: z.string().optional().describe('Directory to search in (default: current dir)'),
    file_pattern: z.string().optional().describe('File glob to filter, e.g. "*.py" (default: all files)'),
  }, (p) => executor('search_content', p));

  // --- Shell ---
  server.tool('run_command', 'Execute a shell command and return its output.', {
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
    cwd: z.string().optional().describe('Working directory (default: home)'),
  }, (p) => executor('run_command', p));

  server.tool('get_processes', 'List running processes.', {
    filter: z.string().optional().describe('Optional filter string to grep processes'),
  }, (p) => executor('get_processes', p));

  // --- Clipboard ---
  server.tool('get_clipboard', 'Read the current clipboard contents.', {}, (p) => executor('get_clipboard', p));

  server.tool('set_clipboard', 'Write text to the clipboard.', {
    text: z.string().describe('Text to copy to clipboard'),
  }, (p) => executor('set_clipboard', p));

  // --- System ---
  server.tool('get_system_info', 'Get system information: OS, hostname, uptime, memory, disk usage.', {}, (p) => executor('get_system_info', p));

  server.tool('send_notification', 'Send a desktop notification.', {
    title: z.string().describe('Notification title'),
    message: z.string().describe('Notification message body'),
  }, (p) => executor('send_notification', p));

  server.tool('get_datetime', 'Get the current date and time.', {}, (p) => executor('get_datetime', p));
}
