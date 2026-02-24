import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { z } from 'zod';

const execAsync = promisify(exec);

export function registerSystemTools(server) {
  server.tool(
    'get_system_info',
    'Get system information: OS, hostname, uptime, memory, disk usage.',
    {},
    async () => {
      try {
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
      } catch (err) {
        return { content: [{ type: 'text', text: `System info failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'send_notification',
    'Send a desktop notification.',
    {
      title: z.string().describe('Notification title'),
      message: z.string().describe('Notification message body'),
    },
    async ({ title, message }) => {
      try {
        await execAsync(`notify-send ${JSON.stringify(title)} ${JSON.stringify(message)}`, { timeout: 5000 });
        return { content: [{ type: 'text', text: `Notification sent: "${title}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Notification failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_datetime',
    'Get the current date and time.',
    {},
    async () => {
      const now = new Date();
      return {
        content: [
          {
            type: 'text',
            text: [
              `Date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
              `Time: ${now.toLocaleTimeString('en-US')}`,
              `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
              `ISO: ${now.toISOString()}`,
            ].join('\n'),
          },
        ],
      };
    }
  );
}
