import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export function registerFilesystemTools(server) {
  server.tool(
    'read_file',
    'Read the contents of a file.',
    { path: z.string().describe('Absolute or relative path to the file') },
    async ({ path }) => {
      try {
        const resolved = resolve(path);
        const content = await readFile(resolved, 'utf-8');
        if (content.length > 100000) {
          return { content: [{ type: 'text', text: content.slice(0, 100000) + '\n... (truncated at 100k chars)' }] };
        }
        return { content: [{ type: 'text', text: content }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Read failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'write_file',
    'Write content to a file. Creates the file if it does not exist.',
    {
      path: z.string().describe('Absolute or relative path to the file'),
      content: z.string().describe('Content to write'),
    },
    async ({ path, content }) => {
      try {
        const resolved = resolve(path);
        await writeFile(resolved, content, 'utf-8');
        return { content: [{ type: 'text', text: `Wrote ${content.length} chars to ${resolved}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Write failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_directory',
    'List the contents of a directory.',
    { path: z.string().optional().describe('Directory path (default: current directory)') },
    async ({ path: dirPath }) => {
      try {
        const resolved = resolve(dirPath || '.');
        const entries = await readdir(resolved, { withFileTypes: true });
        const lines = entries.map((e) => {
          const type = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
          return `[${type}] ${e.name}`;
        });
        return { content: [{ type: 'text', text: `${resolved}/\n${lines.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `List failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'search_files',
    'Search for files by name pattern using find.',
    {
      pattern: z.string().describe('File name pattern (glob), e.g. "*.js"'),
      directory: z.string().optional().describe('Directory to search in (default: home)'),
      max_depth: z.number().optional().describe('Max directory depth (default: 5)'),
    },
    async ({ pattern, directory, max_depth }) => {
      try {
        const dir = resolve(directory || process.env.HOME);
        const depth = max_depth || 5;
        const { stdout } = await execFileAsync('find', [
          dir, '-maxdepth', String(depth), '-name', pattern, '-type', 'f',
        ], { timeout: 10000 });
        const results = stdout.trim();
        return { content: [{ type: 'text', text: results || 'No files found.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Search failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'search_content',
    'Search for text content within files using grep.',
    {
      pattern: z.string().describe('Text or regex pattern to search for'),
      directory: z.string().optional().describe('Directory to search in (default: current dir)'),
      file_pattern: z.string().optional().describe('File glob to filter, e.g. "*.py" (default: all files)'),
    },
    async ({ pattern, directory, file_pattern }) => {
      try {
        const dir = resolve(directory || '.');
        const args = ['-r', '-n', '-l', '--max-count=50'];
        if (file_pattern) {
          args.push('--include', file_pattern);
        }
        args.push(pattern, dir);
        const { stdout } = await execFileAsync('grep', args, { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout.trim() || 'No matches found.' }] };
      } catch (err) {
        if (err.code === 1) {
          return { content: [{ type: 'text', text: 'No matches found.' }] };
        }
        return { content: [{ type: 'text', text: `Search failed: ${err.message}` }], isError: true };
      }
    }
  );
}
