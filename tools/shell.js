import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';

const execAsync = promisify(exec);

export function registerShellTools(server) {
  server.tool(
    'run_command',
    'Execute a shell command and return its output.',
    {
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
      cwd: z.string().optional().describe('Working directory (default: home)'),
    },
    async ({ command, timeout, cwd }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: timeout || 30000,
          cwd: cwd || process.env.HOME,
          maxBuffer: 1024 * 1024,
          shell: '/bin/bash',
        });
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (!output) output = '(no output)';
        if (output.length > 50000) {
          output = output.slice(0, 50000) + '\n... (truncated)';
        }
        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        let msg = err.message;
        if (err.stdout) msg += '\n--- stdout ---\n' + err.stdout;
        if (err.stderr) msg += '\n--- stderr ---\n' + err.stderr;
        return { content: [{ type: 'text', text: `Command failed: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_processes',
    'List running processes.',
    { filter: z.string().optional().describe('Optional filter string to grep processes') },
    async ({ filter }) => {
      try {
        const cmd = filter
          ? `ps aux | head -1; ps aux | grep -i '${filter.replace(/'/g, "\\'")}' | grep -v grep`
          : 'ps aux --sort=-%mem | head -30';
        const { stdout } = await execAsync(cmd, { timeout: 5000 });
        return { content: [{ type: 'text', text: stdout.trim() }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Process list failed: ${err.message}` }], isError: true };
      }
    }
  );
}
