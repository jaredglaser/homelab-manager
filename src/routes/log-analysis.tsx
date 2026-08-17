import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import FindingsFeed from '@/components/findings/FindingsFeed';
import { FeedbackMetrics } from '@/components/findings/FeedbackMetrics';
import ReportIncidentDialog from '@/components/findings/ReportIncidentDialog';
import type { ReportIncidentDialogEntity } from '@/components/findings/ReportIncidentDialog';
import { Button } from '@/components/ui/button';
import { useCanWrite } from '@/hooks/useAuth';
import { useDockerInventory } from '@/hooks/useDockerInventory';
import { useToast } from '@/hooks/toastAtom';
import { reportMiss, setMissStatus } from '@/data/feedback/functions';
import type { ReportMissInput, ReportMissResult } from '@/data/feedback/handlers';

export function LogAnalysisPage() {
  const canWrite = useCanWrite();
  const { inventory } = useDockerInventory();
  const { showToast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [result, setResult] = useState<ReportMissResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const entities = useMemo<ReportIncidentDialogEntity[]>(
    () => [...inventory.values()].map((container) => ({
      entityId: `${container.host}/${container.containerId}`,
      label: container.name,
      host: container.host,
    })),
    [inventory],
  );

  function handleOpenDialog() {
    setResult(null);
    setDialogOpen(true);
  }

  function handleCloseDialog() {
    setDialogOpen(false);
    setResult(null);
  }

  async function handleSubmitMiss(input: ReportMissInput) {
    setIsSubmitting(true);
    try {
      const submitted = await reportMiss({ data: { ...input, entityIds: [...input.entityIds] } });
      setResult(submitted);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to report the incident';
      showToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSetStatus(status: 'accepted' | 'explained') {
    if (!result) return;
    setIsSubmitting(true);
    try {
      await setMissStatus({ data: { id: result.miss.id, status } });
      showToast(status === 'accepted' ? 'Recorded as a missed detection' : 'Recorded as explained', 'success');
      handleCloseDialog();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update the reported miss';
      showToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <FeedbackMetrics />
      {canWrite && (
        <div className="flex justify-end px-4 pt-2">
          <Button type="button" variant="outline" size="sm" onClick={handleOpenDialog}>
            Report an incident
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <FindingsFeed />
      </div>
      <ReportIncidentDialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        onSubmit={handleSubmitMiss}
        result={result}
        onSetStatus={handleSetStatus}
        isLoading={isSubmitting}
        entities={entities}
      />
    </div>
  );
}

export const Route = createFileRoute('/log-analysis')({
  ssr: false,
  validateSearch: z.object({ finding: z.number().int().positive().optional() }),
  component: LogAnalysisPage,
});
