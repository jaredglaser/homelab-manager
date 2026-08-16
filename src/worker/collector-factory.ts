import type { DatabaseClient } from '@/lib/clients/database-client';
import { isProxmoxConfigured, loadProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { BaseCollector } from './collectors/base-collector';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { HermesDispatcher } from './log-watcher/hermes-dispatcher';
import type { BudgetBucket, BudgetStore, HermesRuntimeConfig } from './log-watcher/hermes-dispatcher';
import { DEFAULT_CEILINGS } from './log-watcher/tier';
import type { HermesCeilings } from './log-watcher/tier';

export interface CollectorFactoryResult {
  collectors: BaseCollector[];
  runners: Promise<void>[];
}

/**
 * Rewrite localhost agent URLs so the worker container can reach agents
 * on the same Docker network. Uses WORKER_LOCALHOST_AGENT env var as the
 * Docker-internal hostname (e.g. "hlm-agent"). Remote agent URLs
 * (e.g. 192.168.1.50:9090) pass through unchanged.
 */
export function resolveAgentUrl(url: string): string {
  const dockerHost = process.env.WORKER_LOCALHOST_AGENT;
  if (!dockerHost) return url;
  return url.replace(/:\/\/(\[?::1\]?|localhost|127\.0\.0\.1):/, `://${dockerHost}:`);
}

/**
 * Create and register enabled collectors based on the provided worker configuration.
 *
 * @param proxmoxPollIntervalMs - Optional poll interval in milliseconds for the Proxmox collector; when omitted a default of 10000 ms is used
 * @returns An object with `collectors` - the created collector instances, and `runners` - an array of each collector's run promise
 */
export function createCollectors(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  proxmoxPollIntervalMs?: number,
): CollectorFactoryResult {
  const collectors: BaseCollector[] = [];
  const runners: Promise<void>[] = [];

  if (workerConfig.proxmox.enabled) {
    if (!isProxmoxConfigured()) {
      console.info('[Worker] Proxmox enabled but not configured');
    } else {
      const proxmoxConfig = loadProxmoxConfig();
      console.info(`[Worker] Starting Proxmox collector for ${proxmoxConfig.host}`);
      const collector = stack.use(
        new ProxmoxCollector(db, workerConfig, proxmoxConfig, proxmoxPollIntervalMs ?? 10_000, shutdownController)
      );
      collectors.push(collector);
      runners.push(collector.run());
    }
  } else {
    console.info('[Worker] Proxmox collector disabled');
  }

  return { collectors, runners };
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface HermesEnvConfig {
  readonly gatewayUrl: string;
  readonly dashboardBaseUrl: string;
  readonly ceilings: HermesCeilings;
}

/** Reads the Hermes push-path's non-secret runtime knobs from the environment. */
export function loadHermesEnvConfig(): HermesEnvConfig {
  return {
    gatewayUrl: process.env.HERMES_GATEWAY_URL ?? '',
    dashboardBaseUrl: process.env.HERMES_DASHBOARD_BASE_URL ?? '',
    ceilings: {
      maxInFlight: parsePositiveIntEnv(process.env.HERMES_MAX_IN_FLIGHT, DEFAULT_CEILINGS.maxInFlight),
      maxDailyRuns: parsePositiveIntEnv(process.env.HERMES_MAX_DAILY_RUNS, DEFAULT_CEILINGS.maxDailyRuns),
      maxDailyPages: parsePositiveIntEnv(process.env.HERMES_MAX_DAILY_PAGES, DEFAULT_CEILINGS.maxDailyPages),
    },
  };
}

/** Minimal shape createHermesConfigProvider needs; StackSecretsRepository satisfies this structurally. */
export interface HermesSecretReader {
  get(stackName: string, variableName: string): Promise<string | null>;
}

// stack_secrets (migration 021) is the only JWE-at-rest secret table this codebase has;
// Hermes has no dedicated table of its own yet, so its webhook signing secret is stored
// there under a reserved scope that is never a real git-managed stack name and is never
// enumerated, only looked up by this exact (stack, variable) pair.
export const HERMES_SECRET_STACK_NAME = '__hermes-system__';
export const HERMES_SECRET_VARIABLE_NAME = 'webhookSigningSecret';

export function createHermesConfigProvider(
  secretReader: HermesSecretReader,
  envConfig: HermesEnvConfig,
): () => Promise<HermesRuntimeConfig> {
  return async () => {
    let secret = '';
    try {
      secret = (await secretReader.get(HERMES_SECRET_STACK_NAME, HERMES_SECRET_VARIABLE_NAME)) ?? '';
    } catch (err) {
      console.error('[Worker] Failed to read Hermes webhook secret:', err instanceof Error ? err.message : err);
    }
    return {
      enabled: true,
      gatewayUrl: envConfig.gatewayUrl,
      secret,
      dashboardBaseUrl: envConfig.dashboardBaseUrl,
    };
  };
}

const EMPTY_BUDGET: Record<BudgetBucket, number> = { t0: 0, t1: 0, t2: 0, page: 0 };

/**
 * Fallback for callers with no pool. Daily spend resets on restart, which is the exact
 * hole HermesBudgetRepository closes, so this is only for tests and never the wired path.
 */
export class InMemoryHermesBudgetStore implements BudgetStore {
  private readonly byDay = new Map<string, Record<BudgetBucket, number>>();

  async load(day: string): Promise<Record<BudgetBucket, number>> {
    const current = this.byDay.get(day);
    return current ? { ...current } : { ...EMPTY_BUDGET };
  }

  async increment(day: string, bucket: BudgetBucket, by: number): Promise<void> {
    const current = this.byDay.get(day) ?? { ...EMPTY_BUDGET };
    current[bucket] += by;
    this.byDay.set(day, current);
  }
}

/**
 * Builds the Hermes push-path dispatcher, or null when the feature flag is off. Mirrors
 * how MCP_ENABLED gates the MCP route (src/routes/api/mcp.ts): a single env var, off by
 * default, checked once at the point of construction so a disabled worker never opens
 * the gateway connection or starts a LogWatcher.
 */
export function createHermesDispatcher(
  secretReader: HermesSecretReader,
  signal: AbortSignal,
  budgetStore: BudgetStore = new InMemoryHermesBudgetStore(),
): HermesDispatcher | null {
  if (process.env.HERMES_PUSH_ENABLED !== 'true') return null;

  const envConfig = loadHermesEnvConfig();
  return new HermesDispatcher({
    signal,
    configProvider: createHermesConfigProvider(secretReader, envConfig),
    budgetStore,
    ceilingsProvider: () => envConfig.ceilings,
  });
}
