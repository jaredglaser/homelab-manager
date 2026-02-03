import { createServerFn } from '@tanstack/react-start';
import { streamTextLines } from '../lib/parsers/text-parser';
import { parseZFSIOStat } from '../lib/parsers/zfs-iostat-parser';
import { ZFSRateCalculator } from '../lib/utils/zfs-rate-calculator';
import type { ZFSIOStatWithRates } from '../types/zfs';
import { zfsSSHMiddleware } from '../middleware/ssh-middleware';

const rateCalculator = new ZFSRateCalculator();

export const streamZFSIOStat = createServerFn()
  .middleware([zfsSSHMiddleware])
  .handler(async function* ({ context }): AsyncGenerator<ZFSIOStatWithRates[]> {
    const sshClient = context.ssh;

    try {
      const stream = await sshClient.exec('zpool iostat -vvv 1');
      let currentCycle: ZFSIOStatWithRates[] = [];

      for await (const line of streamTextLines(stream)) {
        if (!line.trim()) continue;

        if (
          line.includes('capacity') &&
          line.includes('operations') &&
          line.includes('bandwidth')
        ) {
          if (currentCycle.length > 0) {
            yield currentCycle;
            currentCycle = [];
          }
          continue;
        }

        const parsed = parseZFSIOStat(line);
        if (!parsed) continue;

        const statsWithRates = rateCalculator.calculate(parsed.name, parsed);
        currentCycle.push(statsWithRates);
      }

      if (currentCycle.length > 0) {
        yield currentCycle;
      }
    } catch (err) {
      console.error('[streamZFSIOStat] Stream error:', err);
      throw err;
    } finally {
      rateCalculator.clear();
    }
  });

export const getZFSPools = createServerFn()
  .middleware([zfsSSHMiddleware])
  .handler(async ({ context }) => {
    const sshClient = context.ssh;

    try {
      const stream = await sshClient.exec('zpool list -H');
      const lines: string[] = [];

      for await (const line of streamTextLines(stream)) {
        if (line.trim()) {
          lines.push(line);
        }
      }

      const pools = lines.map((line) => {
        const parts = line.split(/\s+/);
        return {
          name: parts[0],
          size: parts[1],
          allocated: parts[2],
          free: parts[3],
          capacity: parts[7],
          health: parts[9],
        };
      });

      return pools;
    } catch (err) {
      console.error('[getZFSPools] Error fetching pools:', err);
      throw err;
    }
  });
