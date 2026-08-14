import { useCallback, useState } from 'react';
import { aiAnalysisChannel } from '@/lib/sse/channels/ai-analysis';
import { useSseChannel } from '@/hooks/useSseChannel';
import type { AiAnalysisSnapshot } from '@/types/ai';

const EMPTY_SNAPSHOT: AiAnalysisSnapshot = {
  profiles: [],
  sessions: [],
  observations: [],
  alerts: [],
};

export interface UseAiAnalysisResult {
  snapshot: AiAnalysisSnapshot;
  isConnected: boolean;
  /** True until the first snapshot frame lands, so the page can distinguish empty from not-yet-loaded. */
  isLoading: boolean;
  error: Error | null;
}

/**
 * Subscribes to `/api/ai-analysis`. The server sends the whole snapshot on every
 * change, so there is no merge step: the newest frame replaces state outright.
 */
export function useAiAnalysis(): UseAiAnalysisResult {
  const [snapshot, setSnapshot] = useState<AiAnalysisSnapshot>(EMPTY_SNAPSHOT);
  const [isLoading, setIsLoading] = useState(true);

  const onData = useCallback((next: AiAnalysisSnapshot) => {
    setSnapshot(next);
    setIsLoading(false);
  }, []);

  const { isConnected, error } = useSseChannel(aiAnalysisChannel, {
    onData,
    serviceErrorMessage: 'AI analysis stream unavailable',
  });

  return { snapshot, isConnected, isLoading, error };
}
