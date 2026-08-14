import type { AiAnalysisSnapshot } from '@/types/ai';
import type { AiConfigView } from '@/data/ai/handlers';
import type { ProbeResult } from '@/lib/ai/provider';
import { generateAiSnapshot, MOCK_AI_PROVIDER, MOCK_AI_SETTINGS } from '@/lib/mock/generators/ai';

/**
 * Demo state lives in module scope so a toggle or acknowledgement made in the
 * UI survives until reload, the same way the other mock function modules work.
 */
const snapshot: AiAnalysisSnapshot = generateAiSnapshot();

export const getAiConfig = async (): Promise<AiConfigView> => ({
  provider: MOCK_AI_PROVIDER,
  settings: MOCK_AI_SETTINGS,
});

export const saveAiProvider = async (): Promise<AiConfigView> => ({
  provider: MOCK_AI_PROVIDER,
  settings: MOCK_AI_SETTINGS,
});

export const saveAiSettings = async (): Promise<AiConfigView> => ({
  provider: MOCK_AI_PROVIDER,
  settings: MOCK_AI_SETTINGS,
});

export const testAiEndpoint = async (): Promise<ProbeResult> => ({
  ok: true,
  models: [MOCK_AI_PROVIDER.model, MOCK_AI_PROVIDER.profilerModel ?? MOCK_AI_PROVIDER.model],
  error: null,
});

export const getAiSnapshot = async (): Promise<AiAnalysisSnapshot> => snapshot;

export const setContainerAnalysis = async (data: {
  host: string;
  containerKey: string;
  enabled: boolean;
}): Promise<{ success: true }> => {
  const profile = snapshot.profiles.find(
    (candidate) => candidate.host === data.host && candidate.containerKey === data.containerKey,
  );
  if (profile) profile.enabled = data.enabled;
  return { success: true };
};

export const setAlertStatus = async (data: {
  id: number;
  status: 'open' | 'acknowledged' | 'dismissed';
}): Promise<{ success: true }> => {
  const alert = snapshot.alerts.find((candidate) => candidate.id === data.id);
  if (alert) alert.status = data.status;
  return { success: true };
};
