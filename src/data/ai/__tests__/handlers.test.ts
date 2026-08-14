import { describe, it, expect, mock } from 'bun:test';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { AI_DEFAULTS } from '@/lib/ai/config';
import type { AiAnalysisSnapshot, AiProviderConfig } from '@/types/ai';
import {
  handleGetAiConfig,
  handleGetAiSnapshot,
  handleSaveAiProvider,
  handleSaveAiSettings,
  handleSetAlertStatus,
  handleSetContainerAnalysis,
  handleTestAiEndpoint,
  type AiHandlerDeps,
} from '@/data/ai/handlers';

const EMPTY_SNAPSHOT: AiAnalysisSnapshot = {
  profiles: [],
  sessions: [],
  observations: [],
  alerts: [],
};

interface Harness {
  deps: AiHandlerDeps;
  saved: unknown[];
  settingsStore: Map<string, string>;
  toggles: unknown[];
  alertStatuses: unknown[];
}

function harness(options: { config?: AiProviderConfig | null; apiKey?: string | null } = {}): Harness {
  const saved: unknown[] = [];
  const settingsStore = new Map<string, string>();
  const toggles: unknown[] = [];
  const alertStatuses: unknown[] = [];

  const deps: AiHandlerDeps = {
    provider: {
      getConfig: async () => options.config ?? null,
      getWithKey: async () => (options.apiKey === undefined ? null : { apiKey: options.apiKey }),
      save: async (input) => {
        saved.push(input);
      },
    },
    analysis: {
      listProfiles: async () => EMPTY_SNAPSHOT.profiles,
      listSessions: async () => EMPTY_SNAPSHOT.sessions,
      listObservations: async () => EMPTY_SNAPSHOT.observations,
      listAlerts: async () => EMPTY_SNAPSHOT.alerts,
      setProfileEnabled: async (host, containerKey, enabled) => {
        toggles.push({ host, containerKey, enabled });
      },
      setAlertStatus: async (id, status) => {
        alertStatuses.push({ id, status });
      },
    },
    settings: {
      get: async (key) => settingsStore.get(key) ?? null,
      set: async (key, value) => {
        settingsStore.set(key, value);
      },
    },
  };

  return { deps, saved, settingsStore, toggles, alertStatuses };
}

describe('handleGetAiConfig', () => {
  it('returns defaults when nothing has been configured', async () => {
    const { deps } = harness();
    expect(await handleGetAiConfig(deps)).toEqual({ provider: null, settings: AI_DEFAULTS });
  });

  it('returns the stored provider alongside the resolved settings', async () => {
    const { deps, settingsStore } = harness({
      config: {
        baseUrl: 'http://gpu-box:8080/v1',
        model: 'analyst-8b',
        profilerModel: null,
        hasApiKey: true,
        maxContextTokens: 32_768,
      },
    });
    settingsStore.set(SETTINGS_KEYS.ai.enabled, 'true');

    const view = await handleGetAiConfig(deps);
    expect(view.provider?.hasApiKey).toBe(true);
    expect(view.settings.enabled).toBe(true);
  });
});

describe('handleSaveAiProvider', () => {
  const base = {
    baseUrl: 'http://gpu-box:8080',
    model: 'analyst-8b',
    profilerModel: null,
    maxContextTokens: 32_768,
  };

  it('leaves the stored key alone when the field was not touched', async () => {
    const { deps, saved } = harness();
    await handleSaveAiProvider(deps, base);
    expect((saved[0] as { apiKey?: string | null }).apiKey).toBeUndefined();
  });

  it('clears the stored key when the field was emptied', async () => {
    const { deps, saved } = harness();
    await handleSaveAiProvider(deps, { ...base, apiKey: '' });
    expect((saved[0] as { apiKey?: string | null }).apiKey).toBeNull();
  });

  it('replaces the stored key when a new one is given', async () => {
    const { deps, saved } = harness();
    await handleSaveAiProvider(deps, { ...base, apiKey: 'sk-new' });
    expect((saved[0] as { apiKey?: string | null }).apiKey).toBe('sk-new');
  });

  it('returns the refreshed view', async () => {
    const { deps } = harness();
    expect(await handleSaveAiProvider(deps, base)).toEqual({ provider: null, settings: AI_DEFAULTS });
  });
});

describe('handleSaveAiSettings', () => {
  it('writes every knob and reads them back', async () => {
    const { deps, settingsStore } = harness();
    const view = await handleSaveAiSettings(deps, {
      enabled: true,
      batchLines: 300,
      maxConcurrentAgents: 4,
      profileWindowDays: 5,
      alertSeverity: 'notice',
    });

    expect(settingsStore.get(SETTINGS_KEYS.ai.enabled)).toBe('true');
    expect(settingsStore.get(SETTINGS_KEYS.ai.batchLines)).toBe('300');
    expect(settingsStore.get(SETTINGS_KEYS.ai.maxConcurrentAgents)).toBe('4');
    expect(settingsStore.get(SETTINGS_KEYS.ai.profileWindowDays)).toBe('5');
    expect(settingsStore.get(SETTINGS_KEYS.ai.alertSeverity)).toBe('notice');
    expect(view.settings.batchLines).toBe(300);
  });
});

describe('handleTestAiEndpoint', () => {
  it('probes with the key the caller supplied', async () => {
    const probe = mock(async (_baseUrl: string, _apiKey: string | null) => ({ ok: true, models: ['a'], error: null }));
    const { deps } = harness({ apiKey: 'sk-stored' });
    const result = await handleTestAiEndpoint(
      { ...deps, probe: probe as never },
      { baseUrl: 'http://gpu-box:8080', apiKey: 'sk-typed' },
    );

    expect(result.ok).toBe(true);
    expect(probe.mock.calls[0][1]).toBe('sk-typed');
  });

  it('falls back to the stored key when the caller sent none', async () => {
    const probe = mock(async (_baseUrl: string, _apiKey: string | null) => ({ ok: true, models: [], error: null }));
    const { deps } = harness({ apiKey: 'sk-stored' });
    await handleTestAiEndpoint({ ...deps, probe: probe as never }, { baseUrl: 'http://gpu-box:8080' });
    expect(probe.mock.calls[0][1]).toBe('sk-stored');
  });

  it('probes anonymously when nothing is stored', async () => {
    const probe = mock(async (_baseUrl: string, _apiKey: string | null) => ({ ok: false, models: [], error: 'nope' }));
    const { deps } = harness();
    await handleTestAiEndpoint({ ...deps, probe: probe as never }, { baseUrl: 'http://gpu-box:8080' });
    expect(probe.mock.calls[0][1]).toBeNull();
  });
});

describe('handleSetContainerAnalysis', () => {
  it('forwards the toggle', async () => {
    const { deps, toggles } = harness();
    expect(
      await handleSetContainerAnalysis(deps, { host: 'nuc', containerKey: 'media/plex', enabled: false }),
    ).toEqual({ success: true });
    expect(toggles).toEqual([{ host: 'nuc', containerKey: 'media/plex', enabled: false }]);
  });
});

describe('handleSetAlertStatus', () => {
  it('forwards the status change', async () => {
    const { deps, alertStatuses } = harness();
    expect(await handleSetAlertStatus(deps, { id: 5, status: 'acknowledged' })).toEqual({ success: true });
    expect(alertStatuses).toEqual([{ id: 5, status: 'acknowledged' }]);
  });
});

describe('handleGetAiSnapshot', () => {
  it('assembles all four lists', async () => {
    const { deps } = harness();
    expect(await handleGetAiSnapshot(deps)).toEqual(EMPTY_SNAPSHOT);
  });
});
