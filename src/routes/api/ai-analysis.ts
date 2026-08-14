import { createFileRoute } from '@tanstack/react-router';
import { createBroadcastSseHandler } from '@/lib/sse/create-broadcast-sse-handler';
import { aiAnalysisChannel, serializeAiAnalysisSnapshot } from '@/lib/sse/channels/ai-analysis';
import type { AiAnalysisSnapshot } from '@/types/ai';

export const Route = createFileRoute('/api/ai-analysis')({
  server: {
    handlers: {
      GET: createBroadcastSseHandler<AiAnalysisSnapshot>({
        loadSubscribe: async () => {
          await import('@/lib/server-init');
          const { aiAnalysisBroadcastService } = await import('@/lib/ai/ai-analysis-broadcast-service');
          return (cb) => aiAnalysisBroadcastService.subscribe(cb);
        },
        serialize: serializeAiAnalysisSnapshot,
        errorEvent: aiAnalysisChannel.errorEvent,
      }),
    },
  },
});
