import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { loadProxmoxConfig, type ProxmoxConfig } from '@/lib/config/proxmox-config';
import { proxmoxConnectionManager } from '@/lib/clients/proxmox-client';
import { ProxmoxRateCalculator } from '@/lib/utils/proxmox-rate-calculator';
import type { RawStatRow } from '@/lib/database/repositories/stats-repository';
import type { ProxmoxStatsWithRates } from '@/types/proxmox';
import { parseIPFromNetConfig } from '@/lib/utils/ip-utils';
import { BaseCollector } from './base-collector';

const PROXMOX_SOURCE = 'proxmox';

/** Convert node stats to raw stat rows for DB insertion */
function nodeToRawStatRows(
  node: ProxmoxStatsWithRates,
  entityPath: string
): RawStatRow[] {
  const timestamp = new Date();
  return [
    { timestamp, source: PROXMOX_SOURCE, type: 'cpu_percent', entity: entityPath, value: node.rates.cpuPercent },
    { timestamp, source: PROXMOX_SOURCE, type: 'memory_usage', entity: entityPath, value: node.mem },
    { timestamp, source: PROXMOX_SOURCE, type: 'memory_limit', entity: entityPath, value: node.maxmem },
    { timestamp, source: PROXMOX_SOURCE, type: 'memory_percent', entity: entityPath, value: node.rates.memoryPercent },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_usage', entity: entityPath, value: node.disk },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_limit', entity: entityPath, value: node.maxdisk },
    { timestamp, source: PROXMOX_SOURCE, type: 'network_in_bytes_per_sec', entity: entityPath, value: node.rates.networkInBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'network_out_bytes_per_sec', entity: entityPath, value: node.rates.networkOutBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_read_bytes_per_sec', entity: entityPath, value: node.rates.diskReadBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_write_bytes_per_sec', entity: entityPath, value: node.rates.diskWriteBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'uptime', entity: entityPath, value: node.uptime },
    { timestamp, source: PROXMOX_SOURCE, type: 'status', entity: entityPath, value: 1 }, // If we can see it, it's online
  ];
}

/** Convert guest (VM/LXC) stats to raw stat rows */
function guestToRawStatRows(
  guest: ProxmoxStatsWithRates,
  entityPath: string,
  status: string
): RawStatRow[] {
  const timestamp = new Date();
  return [
    { timestamp, source: PROXMOX_SOURCE, type: 'cpu_percent', entity: entityPath, value: guest.rates.cpuPercent },
    { timestamp, source: PROXMOX_SOURCE, type: 'memory_usage', entity: entityPath, value: guest.mem },
    { timestamp, source: PROXMOX_SOURCE, type: 'memory_limit', entity: entityPath, value: guest.maxmem },
    { timestamp, source: PROXMOX_SOURCE, type: 'memory_percent', entity: entityPath, value: guest.rates.memoryPercent },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_usage', entity: entityPath, value: guest.disk },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_limit', entity: entityPath, value: guest.maxdisk },
    { timestamp, source: PROXMOX_SOURCE, type: 'network_in_bytes_per_sec', entity: entityPath, value: guest.rates.networkInBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'network_out_bytes_per_sec', entity: entityPath, value: guest.rates.networkOutBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_read_bytes_per_sec', entity: entityPath, value: guest.rates.diskReadBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'disk_write_bytes_per_sec', entity: entityPath, value: guest.rates.diskWriteBytesPerSec },
    { timestamp, source: PROXMOX_SOURCE, type: 'uptime', entity: entityPath, value: guest.uptime },
    { timestamp, source: PROXMOX_SOURCE, type: 'status', entity: entityPath, value: status === 'running' ? 1 : 0 },
  ];
}

export class ProxmoxCollector extends BaseCollector {
  readonly name = 'ProxmoxCollector';
  private readonly calculator = new ProxmoxRateCalculator();
  private proxmoxConfig: ProxmoxConfig | null = null;
  private knownEntities = new Map<string, {
    name: string;
    type: string;
    status: string;
    tags: string;
    ipAddresses: string;
  }>();

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    abortController?: AbortController
  ) {
    super(db, config, abortController);
    try {
      this.proxmoxConfig = loadProxmoxConfig();
    } catch {
      this.proxmoxConfig = null;
    }
  }

  protected isConfigured(): boolean {
    return this.proxmoxConfig !== null && !!this.proxmoxConfig.host && !!this.proxmoxConfig.tokenId;
  }

  protected async collectOnce(): Promise<void> {
    if (!this.proxmoxConfig) return;

    const t0 = performance.now();
    this.debugLog(`[${this.name}] Starting collection cycle`);

    const proxmoxClient = await proxmoxConnectionManager.getClient(this.proxmoxConfig);
    const api = proxmoxClient.getApi();
    const tConnect = performance.now();

    // Fetch all cluster resources in a single API call
    const resources: any[] = await api.cluster.resources.$get();
    const tResources = performance.now();

    this.debugLog(
      `[${this.name}] Got ${resources.length} resources` +
      ` (connect=${(tConnect - t0).toFixed(0)}ms` +
      ` resources=${(tResources - tConnect).toFixed(0)}ms)`
    );
    this.resetBackoff();

    // Process nodes
    const nodes = resources.filter((r: any) => r.type === 'node');
    for (const node of nodes) {
      const entityPath = node.node;
      if (!this.shouldWrite(entityPath)) continue;

      const statsInput = {
        id: entityPath,
        cpu: node.cpu ?? 0,
        mem: node.mem ?? 0,
        maxmem: node.maxmem ?? 0,
        disk: node.disk ?? 0,
        maxdisk: node.maxdisk ?? 0,
        netin: 0,
        netout: 0,
        diskread: 0,
        diskwrite: 0,
        uptime: node.uptime ?? 0,
      };

      const withRates = this.calculator.calculate(entityPath, statsInput);
      await this.addToBatch(nodeToRawStatRows(withRates, entityPath));

      // Upsert metadata if changed
      await this.upsertMetadataIfChanged(entityPath, {
        name: node.node,
        type: 'node',
        status: node.status ?? 'unknown',
        tags: '',
        ipAddresses: '',
      });
    }

    // Process VMs and LXCs
    const guests = resources.filter((r: any) => r.type === 'qemu' || r.type === 'lxc');
    for (const guest of guests) {
      const guestType = guest.type as 'qemu' | 'lxc';
      const entityPath = `${guest.node}/${guestType}/${guest.vmid}`;
      if (!this.shouldWrite(entityPath)) continue;

      const statsInput = {
        id: entityPath,
        cpu: guest.cpu ?? 0,
        mem: guest.mem ?? 0,
        maxmem: guest.maxmem ?? 0,
        disk: guest.disk ?? 0,
        maxdisk: guest.maxdisk ?? 0,
        netin: guest.netin ?? 0,
        netout: guest.netout ?? 0,
        diskread: guest.diskread ?? 0,
        diskwrite: guest.diskwrite ?? 0,
        uptime: guest.uptime ?? 0,
      };

      const withRates = this.calculator.calculate(entityPath, statsInput);
      await this.addToBatch(guestToRawStatRows(withRates, entityPath, guest.status));

      await this.upsertMetadataIfChanged(entityPath, {
        name: guest.name ?? `${guestType}-${guest.vmid}`,
        type: guestType,
        status: guest.status ?? 'unknown',
        tags: guest.tags ?? '',
        ipAddresses: '',
      });
    }

    // Collect IPs from guest configs (less frequently - only with metadata changes)
    await this.collectGuestIPs(api, guests);

    // Collect replication info
    await this.collectReplication(api, nodes);

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    this.debugLog(`[${this.name}] Collection cycle completed in ${elapsed}s`);

    // Close connection so next cycle forces a fresh one
    await proxmoxClient.close();
  }

  private async collectGuestIPs(api: any, guests: any[]): Promise<void> {
    for (const guest of guests) {
      if (this.signal.aborted) break;

      const guestType = guest.type as 'qemu' | 'lxc';
      const entityPath = `${guest.node}/${guestType}/${guest.vmid}`;

      try {
        const ips: string[] = [];

        if (guestType === 'lxc') {
          // LXC containers have IPs in their config
          const config = await api.nodes.$(guest.node).lxc.$(guest.vmid).config.$get();
          for (let i = 0; i < 10; i++) {
            const netKey = `net${i}`;
            const netConfig = config[netKey];
            if (netConfig) {
              const ip = parseIPFromNetConfig(netConfig);
              if (ip) ips.push(ip);
            }
          }
        } else if (guestType === 'qemu' && guest.status === 'running') {
          // QEMU VMs need guest agent for IPs
          try {
            const agentData = await api.nodes.$(guest.node).qemu.$(guest.vmid).agent['network-get-interfaces'].$get();
            const interfaces = agentData?.result ?? agentData ?? [];
            for (const iface of interfaces) {
              if (iface.name === 'lo') continue;
              const ipAddrs = iface['ip-addresses'] ?? [];
              for (const addr of ipAddrs) {
                if (addr['ip-address-type'] === 'ipv4' && addr['ip-address'] !== '127.0.0.1') {
                  ips.push(addr['ip-address']);
                }
              }
            }
          } catch {
            // Guest agent not available — skip silently
          }
        }

        if (ips.length > 0) {
          const ipString = ips.join(',');
          const known = this.knownEntities.get(entityPath);
          if (!known || known.ipAddresses !== ipString) {
            await this.repository.upsertEntityMetadata(PROXMOX_SOURCE, entityPath, 'ip_addresses', ipString);
            if (known) known.ipAddresses = ipString;
          }
        }
      } catch {
        // Config fetch failed — skip this guest
      }
    }
  }

  private async collectReplication(api: any, nodes: any[]): Promise<void> {
    try {
      const replicationJobs: any[] = await api.cluster.replication.$get();
      for (const job of replicationJobs) {
        if (this.signal.aborted) break;

        const guestEntity = this.findGuestEntity(job.guest);
        if (!guestEntity) continue;

        const replicationData = JSON.stringify({
          id: job.id,
          type: job.type ?? 'local',
          source: job.source ?? '',
          target: job.target ?? '',
          schedule: job.schedule ?? '',
          comment: job.comment ?? '',
        });

        await this.repository.upsertEntityMetadata(
          PROXMOX_SOURCE,
          guestEntity,
          'replication',
          replicationData
        );
      }

      // Collect replication status from nodes
      for (const node of nodes) {
        if (this.signal.aborted) break;
        try {
          const nodeReplication: any[] = await api.nodes.$(node.node).replication.$get();
          for (const job of nodeReplication) {
            const guestEntity = this.findGuestEntity(job.guest);
            if (!guestEntity) continue;

            const statusData = JSON.stringify({
              lastSync: job.last_sync ?? null,
              nextSync: job.next_sync ?? null,
              duration: job.duration ?? null,
              failCount: job.fail_count ?? 0,
              error: job.error ?? null,
            });

            await this.repository.upsertEntityMetadata(
              PROXMOX_SOURCE,
              guestEntity,
              'replication_status',
              statusData
            );
          }
        } catch {
          // Node replication query failed — skip
        }
      }
    } catch {
      // Replication not configured or not available
    }
  }

  private findGuestEntity(vmid: number): string | null {
    for (const [entity, meta] of this.knownEntities) {
      if (entity.endsWith(`/${vmid}`) && meta.type !== 'node') {
        return entity;
      }
    }
    return null;
  }

  private async upsertMetadataIfChanged(
    entityPath: string,
    current: { name: string; type: string; status: string; tags: string; ipAddresses: string }
  ): Promise<void> {
    const known = this.knownEntities.get(entityPath);

    if (!known ||
      known.name !== current.name ||
      known.type !== current.type ||
      known.status !== current.status ||
      known.tags !== current.tags
    ) {
      await this.repository.upsertEntityMetadata(PROXMOX_SOURCE, entityPath, 'name', current.name);
      await this.repository.upsertEntityMetadata(PROXMOX_SOURCE, entityPath, 'type', current.type);
      await this.repository.upsertEntityMetadata(PROXMOX_SOURCE, entityPath, 'status', current.status);
      if (current.tags) {
        await this.repository.upsertEntityMetadata(PROXMOX_SOURCE, entityPath, 'tags', current.tags);
      }
      this.knownEntities.set(entityPath, { ...current });
    }
  }
}
