import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import { ZFSRateCalculator } from '@/lib/utils/zfs-rate-calculator';
import type { RawStatRow } from '@/lib/database/repositories/stats-repository';
import { streamTextLines } from '@/lib/parsers/text-parser';
import { parseZFSIOStat } from '@/lib/parsers/zfs-iostat-parser';
import type { ZFSIOStatWithRates } from '@/types/zfs';
import { BaseCollector } from './base-collector';

const ZFS_SOURCE = 'zfs';

function toRawStatRows(stat: ZFSIOStatWithRates): RawStatRow[] {
  const timestamp = new Date(stat.timestamp);
  const entity = stat.name;

  return [
    { timestamp, source: ZFS_SOURCE, type: 'capacity_alloc', entity, value: stat.capacity.alloc },
    { timestamp, source: ZFS_SOURCE, type: 'capacity_free', entity, value: stat.capacity.free },
    { timestamp, source: ZFS_SOURCE, type: 'read_ops_per_sec', entity, value: stat.rates.readOpsPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'write_ops_per_sec', entity, value: stat.rates.writeOpsPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'read_bytes_per_sec', entity, value: stat.rates.readBytesPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'write_bytes_per_sec', entity, value: stat.rates.writeBytesPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'utilization_percent', entity, value: stat.rates.utilizationPercent },
  ];
}

export class ZFSCollector extends BaseCollector {
  readonly name = 'ZFSCollector';
  private readonly calculator = new ZFSRateCalculator();

  constructor(db: DatabaseClient, config: WorkerConfig, abortController?: AbortController) {
    super(db, config, abortController);
  }

  protected isConfigured(): boolean {
    return !!(process.env.ZFS_SSH_HOST && process.env.ZFS_SSH_USER);
  }

  protected async collectOnce(): Promise<void> {
    const sshClient = await sshConnectionManager.getClient({
      id: 'ssh-worker-zfs',
      type: 'ssh',
      host: process.env.ZFS_SSH_HOST!,
      port: parseInt(process.env.ZFS_SSH_PORT || '22', 10),
      auth: {
        type: process.env.ZFS_SSH_KEY_PATH ? 'privateKey' : 'password',
        username: process.env.ZFS_SSH_USER!,
        ...(process.env.ZFS_SSH_KEY_PATH && { privateKeyPath: process.env.ZFS_SSH_KEY_PATH }),
        ...(process.env.ZFS_SSH_PASSWORD && { password: process.env.ZFS_SSH_PASSWORD }),
      },
    });

    console.log(`[${this.name}] Connected to ZFS host, starting iostat stream`);
    this.resetBackoff();

    const stream = await sshClient.exec('zpool iostat -vvv 1');
    let currentCycle: ZFSIOStatWithRates[] = [];

    for await (const line of streamTextLines(stream)) {
      if (this.signal.aborted) break;

      if (!line.trim()) continue;

      // Detect cycle boundary (header line)
      if (
        line.includes('capacity') &&
        line.includes('operations') &&
        line.includes('bandwidth')
      ) {
        if (currentCycle.length > 0) {
          await this.addToBatch(currentCycle.flatMap(toRawStatRows));
          currentCycle = [];
        }
        continue;
      }

      const parsed = parseZFSIOStat(line);
      if (!parsed) continue;

      const statsWithRates = this.calculator.calculate(parsed.name, parsed);
      currentCycle.push(statsWithRates);
    }

    // Flush final cycle
    if (currentCycle.length > 0) {
      await this.addToBatch(currentCycle.flatMap(toRawStatRows));
    }
  }
}
