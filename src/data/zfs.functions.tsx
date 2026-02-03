import { createServerFn } from '@tanstack/react-start';
import { streamTextLines } from '../lib/parsers/text-parser';
import { parseZFSIOStat } from '../lib/parsers/zfs-iostat-parser';
import { ZFSRateCalculator } from '../lib/utils/zfs-rate-calculator';
import type { ZFSIOStatWithRates } from '../types/zfs';
import { zfsSSHMiddleware } from '../middleware/ssh-middleware';

// Rate calculator instance (module-level singleton)
const rateCalculator = new ZFSRateCalculator();

/**
 * Stream ZFS iostat data via SSH
 * Executes: zpool iostat -vvv 1
 *
 * Yields a complete array of parsed stats per update cycle.
 * Cycle boundaries are detected by the repeating header line
 * ("capacity  operations  bandwidth") that zpool iostat emits
 * before each new set of data.
 */
export const streamZFSIOStat = createServerFn()
  .middleware([zfsSSHMiddleware])
  .handler(async function* ({ context }): AsyncGenerator<ZFSIOStatWithRates[]> {
    console.log('[streamZFSIOStat] Starting ZFS iostat stream');
    const sshClient = context.ssh;

    try {
      const command = 'zpool iostat -vvv 1';
      console.log(`[streamZFSIOStat] Executing: ${command}`);

      const stream = await sshClient.exec(command);
      let currentCycle: ZFSIOStatWithRates[] = [];

      for await (const line of streamTextLines(stream)) {
        if (!line.trim()) continue;

        // The "capacity  operations  bandwidth" header repeats before each cycle.
        // When we see it and already have buffered data, yield the completed cycle.
        if (
          line.includes('capacity') &&
          line.includes('operations') &&
          line.includes('bandwidth')
        ) {
          if (currentCycle.length > 0) {
            console.log(
              `[streamZFSIOStat] Cycle complete – ${currentCycle.length} stats`
            );
            yield currentCycle;
            currentCycle = [];
          }
          continue;
        }

        // Parse the line (headers, separators, and garbage are returned as null)
        const parsed = parseZFSIOStat(line);
        if (!parsed) continue;

        const statsWithRates = rateCalculator.calculate(parsed.name, parsed);
        currentCycle.push(statsWithRates);
      }

      // Yield any remaining buffered stats when the stream ends
      if (currentCycle.length > 0) {
        console.log(
          `[streamZFSIOStat] Final cycle – ${currentCycle.length} stats`
        );
        yield currentCycle;
      }

      console.log('[streamZFSIOStat] Stream completed normally');
    } catch (err) {
      console.error('[streamZFSIOStat] Stream error:', err);
      throw err;
    } finally {
      rateCalculator.clear();
    }
  });

/**
 * Get list of ZFS pools (non-streaming)
 * Executes: zpool list -H
 *
 * Returns array of pool information
 */
export const getZFSPools = createServerFn()
  .middleware([zfsSSHMiddleware])
  .handler(async ({ context }) => {
    console.log('[getZFSPools] Fetching ZFS pools');
    const sshClient = context.ssh;

    try {
      // Execute zpool list with -H for parseable output (no headers)
      const stream = await sshClient.exec('zpool list -H');
      const lines: string[] = [];

      for await (const line of streamTextLines(stream)) {
        if (line.trim()) {
          lines.push(line);
        }
      }

      // Parse zpool list output
      // Format: NAME SIZE ALLOC FREE CKPOINT EXPANDSZ FRAG CAP DEDUP HEALTH ALTROOT
      const pools = lines.map((line) => {
        const parts = line.split(/\s+/);
        return {
          name: parts[0],
          size: parts[1],
          allocated: parts[2],
          free: parts[3],
          capacity: parts[7], // CAP column
          health: parts[9], // HEALTH column
        };
      });

      console.log(`[getZFSPools] Found ${pools.length} pools`);
      return pools;
    } catch (err) {
      console.error('[getZFSPools] Error fetching pools:', err);
      throw err;
    }
  });
