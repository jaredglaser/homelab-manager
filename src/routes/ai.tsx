import { useCallback, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import PageStatusBar from '@/components/PageStatusBar';
import { AiAlertsPanel } from '@/components/ai/AiAlertsPanel';
import { AiContainerTable } from '@/components/ai/AiContainerTable';
import { AiObservationFeed } from '@/components/ai/AiObservationFeed';
import { useAiAnalysis } from '@/hooks/useAiAnalysis';
import { setAlertStatus, setContainerAnalysis } from '@/data/ai/functions';
import type { AiAlertStatus } from '@/types/ai';

export const Route = createFileRoute('/ai')({
  ssr: false,
  component: AiPage,
});

function AiPage() {
  const { snapshot, isConnected, isLoading, error } = useAiAnalysis();
  const [pendingAlertId, setPendingAlertId] = useState<number | null>(null);

  const handleAlertStatus = useCallback((id: number, status: AiAlertStatus) => {
    setPendingAlertId(id);
    setAlertStatus({ data: { id, status } })
      .catch((err) => console.error('[ai] Failed to update alert status:', err))
      .finally(() => setPendingAlertId(null));
  }, []);

  const handleToggle = useCallback((host: string, containerKey: string, enabled: boolean) => {
    setContainerAnalysis({ data: { host, containerKey, enabled } }).catch((err) =>
      console.error('[ai] Failed to toggle container analysis:', err),
    );
  }, []);

  const activeSessions = snapshot.sessions.filter((session) => session.status === 'active').length;
  const openAlerts = snapshot.alerts.filter((alert) => alert.status === 'open').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageStatusBar
        left={
          <div className="flex items-center gap-3 text-sm">
            <span>{snapshot.profiles.length} container(s)</span>
            <span>{activeSessions} active session(s)</span>
            {openAlerts > 0 && <Badge variant="destructive">{openAlerts} open alert(s)</Badge>}
          </div>
        }
        right={
          <Badge variant={isConnected ? 'success' : 'outline'}>
            {isConnected ? 'live' : 'disconnected'}
          </Badge>
        }
      />

      {error && (
        <p className="py-8 text-base text-destructive">
          Failed to connect to the AI analysis stream: {error.message}
        </p>
      )}

      {!error && isLoading && (
        <div className="flex items-center gap-3 py-12">
          <Spinner className="size-5" />
          <p className="text-base">Loading fleet analysis...</p>
        </div>
      )}

      {!error && !isLoading && (
        <div className="flex flex-col gap-4 pb-6">
          <AiAlertsPanel
            alerts={snapshot.alerts}
            onSetStatus={handleAlertStatus}
            pendingId={pendingAlertId}
          />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <AiContainerTable
              profiles={snapshot.profiles}
              sessions={snapshot.sessions}
              onToggle={handleToggle}
            />
            <AiObservationFeed observations={snapshot.observations} />
          </div>
        </div>
      )}
    </div>
  );
}
