import type { z } from 'zod';
import type { AiAlertStatus, AiAnalysisSnapshot, AiProviderConfig } from '@/types/ai';
import type { AiRuntimeSettings } from '@/lib/ai/config';
import { AI_DEFAULTS, resolveAiSettings } from '@/lib/ai/config';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { probeEndpoint, type ProbeResult } from '@/lib/ai/provider';
import type {
  saveAiProviderSchema,
  saveAiSettingsSchema,
  setAlertStatusSchema,
  setContainerAnalysisSchema,
  testAiEndpointSchema,
} from '@/data/ai/schemas';

export interface AiProviderRepo {
  getConfig(): Promise<AiProviderConfig | null>;
  getWithKey(): Promise<{ apiKey: string | null } | null>;
  save(input: {
    baseUrl: string;
    model: string;
    profilerModel: string | null;
    maxContextTokens: number;
    apiKey?: string | null;
  }): Promise<void>;
}

export interface AiAnalysisRepo {
  listProfiles(): Promise<AiAnalysisSnapshot['profiles']>;
  listSessions(limit?: number): Promise<AiAnalysisSnapshot['sessions']>;
  listObservations(limit?: number): Promise<AiAnalysisSnapshot['observations']>;
  listAlerts(limit?: number): Promise<AiAnalysisSnapshot['alerts']>;
  setProfileEnabled(host: string, containerKey: string, enabled: boolean): Promise<void>;
  setAlertStatus(id: number, status: AiAlertStatus): Promise<void>;
}

export interface AiSettingsRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface AiHandlerDeps {
  provider: AiProviderRepo;
  analysis: AiAnalysisRepo;
  settings: AiSettingsRepo;
  probe?: typeof probeEndpoint;
}

export interface AiConfigView {
  provider: AiProviderConfig | null;
  settings: AiRuntimeSettings;
}

export const AI_UNCONFIGURED: AiConfigView = { provider: null, settings: AI_DEFAULTS };

export async function handleGetAiConfig(deps: AiHandlerDeps): Promise<AiConfigView> {
  const keys = Object.values(SETTINGS_KEYS.ai);
  const entries = await Promise.all(keys.map(async (key) => [key, await deps.settings.get(key)] as const));
  return {
    provider: await deps.provider.getConfig(),
    settings: resolveAiSettings(Object.fromEntries(entries)),
  };
}

export async function handleSaveAiProvider(
  deps: AiHandlerDeps,
  input: z.infer<typeof saveAiProviderSchema>,
): Promise<AiConfigView> {
  // An empty string is the UI's "forget the stored key"; an absent field means
  // the form was submitted without touching the key at all.
  const apiKey = input.apiKey === undefined ? undefined : input.apiKey === '' ? null : input.apiKey;
  await deps.provider.save({
    baseUrl: input.baseUrl,
    model: input.model,
    profilerModel: input.profilerModel,
    maxContextTokens: input.maxContextTokens,
    apiKey,
  });
  return handleGetAiConfig(deps);
}

export async function handleSaveAiSettings(
  deps: AiHandlerDeps,
  input: z.infer<typeof saveAiSettingsSchema>,
): Promise<AiConfigView> {
  await deps.settings.set(SETTINGS_KEYS.ai.enabled, String(input.enabled));
  await deps.settings.set(SETTINGS_KEYS.ai.batchLines, String(input.batchLines));
  await deps.settings.set(SETTINGS_KEYS.ai.maxConcurrentAgents, String(input.maxConcurrentAgents));
  await deps.settings.set(SETTINGS_KEYS.ai.profileWindowDays, String(input.profileWindowDays));
  await deps.settings.set(SETTINGS_KEYS.ai.alertSeverity, input.alertSeverity);
  return handleGetAiConfig(deps);
}

export async function handleTestAiEndpoint(
  deps: AiHandlerDeps,
  input: z.infer<typeof testAiEndpointSchema>,
): Promise<ProbeResult> {
  const probe = deps.probe ?? probeEndpoint;
  let apiKey = input.apiKey ?? null;
  if (input.apiKey === undefined) {
    apiKey = (await deps.provider.getWithKey())?.apiKey ?? null;
  }
  return probe(input.baseUrl, apiKey);
}

export async function handleSetContainerAnalysis(
  deps: AiHandlerDeps,
  input: z.infer<typeof setContainerAnalysisSchema>,
): Promise<{ success: true }> {
  await deps.analysis.setProfileEnabled(input.host, input.containerKey, input.enabled);
  return { success: true };
}

export async function handleSetAlertStatus(
  deps: AiHandlerDeps,
  input: z.infer<typeof setAlertStatusSchema>,
): Promise<{ success: true }> {
  await deps.analysis.setAlertStatus(input.id, input.status);
  return { success: true };
}

/** REST preload for the `/ai` route, so first paint doesn't wait on the SSE handshake. */
export async function handleGetAiSnapshot(deps: AiHandlerDeps): Promise<AiAnalysisSnapshot> {
  const [profiles, sessions, observations, alerts] = await Promise.all([
    deps.analysis.listProfiles(),
    deps.analysis.listSessions(),
    deps.analysis.listObservations(),
    deps.analysis.listAlerts(),
  ]);
  return { profiles, sessions, observations, alerts };
}
