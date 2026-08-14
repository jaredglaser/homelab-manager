import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import type { Pool } from 'pg';
import type { DatabaseClient } from '@/lib/clients/database-client';
import { AI_DEFAULTS, type AiRuntimeSettings } from '@/lib/ai/config';
import type { AiProviderRow } from '@/lib/database/repositories/ai-provider-repository';
import { startFleetLogAnalysis } from '@/worker/ai/start-fleet-log-analysis';

/**
 * Every repository the composition root builds runs against this pool. An empty
 * result set is enough to make the reconcile find no containers and the triage
 * pass find no observations, so both loops run for real without a database.
 */
function emptyPool(): Pool {
  return { query: async () => ({ rows: [] }) } as unknown as Pool;
}

const db = { getPool: emptyPool } as unknown as DatabaseClient;

const CONFIGURED_PROVIDER: AiProviderRow = {
  baseUrl: 'http://gpu-box:8080',
  model: 'analyst-8b',
  profilerModel: 'profiler-70b',
  hasApiKey: false,
  maxContextTokens: 32_768,
  apiKey: null,
};

function start(options: {
  settings: AiRuntimeSettings;
  provider: AiProviderRow | null;
  signal: AbortSignal;
  onSettingsLoad?: () => void;
}) {
  return startFleetLogAnalysis({
    db,
    getSigner: async () => null,
    signal: options.signal,
    reconcileIntervalMs: 1,
    triageIntervalMs: 1,
    loadSettings: async () => {
      options.onSettingsLoad?.();
      return options.settings;
    },
    loadProvider: async () => options.provider,
  });
}

describe('startFleetLogAnalysis', () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  it('returns null when the feature is off', async () => {
    const handle = await start({
      settings: AI_DEFAULTS,
      provider: CONFIGURED_PROVIDER,
      signal: new AbortController().signal,
    });
    expect(handle).toBeNull();
  });

  it('returns null and says so when enabled with no endpoint', async () => {
    const handle = await start({
      settings: { ...AI_DEFAULTS, enabled: true },
      provider: null,
      signal: new AbortController().signal,
    });
    expect(handle).toBeNull();
    expect(infoSpy.mock.calls.flat().join(' ')).toContain('no endpoint configured');
  });

  it('starts the manager and both loops when configured', async () => {
    const controller = new AbortController();
    const handle = await start({
      settings: { ...AI_DEFAULTS, enabled: true },
      provider: CONFIGURED_PROVIDER,
      signal: controller.signal,
    });

    expect(handle).not.toBeNull();
    expect(handle!.runners).toHaveLength(2);
    // No containers in the empty snapshot, so nothing is being watched yet.
    expect(handle!.manager.entityIds()).toEqual([]);
    expect(infoSpy.mock.calls.flat().join(' ')).toContain('analyst=analyst-8b');

    controller.abort();
    await Promise.all(handle!.runners);
    await handle!.manager[Symbol.asyncDispose]();
  });

  it('keeps both loops running until the signal aborts', async () => {
    const controller = new AbortController();
    let reconciles = 0;
    const pool = {
      query: async (sql: string) => {
        // Every reconcile reads the container snapshot; count those to prove
        // the interval loop is still turning.
        if (typeof sql === 'string' && sql.includes('docker_container_events')) reconciles += 1;
        return { rows: [] };
      },
    } as unknown as Pool;

    const handle = await startFleetLogAnalysis({
      db: { getPool: () => pool } as unknown as DatabaseClient,
      getSigner: async () => null,
      signal: controller.signal,
      reconcileIntervalMs: 1,
      triageIntervalMs: 1,
      loadSettings: async () => ({ ...AI_DEFAULTS, enabled: true }),
      loadProvider: async () => CONFIGURED_PROVIDER,
    });

    while (reconciles < 2) await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();
    await Promise.all(handle!.runners);
    await handle!.manager[Symbol.asyncDispose]();

    expect(reconciles).toBeGreaterThanOrEqual(2);
  });
});
