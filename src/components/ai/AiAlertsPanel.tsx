import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SeverityBadge } from '@/components/ai/SeverityBadge';
import type { AiAlert, AiAlertStatus } from '@/types/ai';

export interface AiAlertsPanelProps {
  alerts: AiAlert[];
  onSetStatus: (id: number, status: AiAlertStatus) => void;
  pendingId?: number | null;
}

export function AiAlertsPanel({ alerts, onSetStatus, pendingId = null }: Readonly<AiAlertsPanelProps>) {
  const open = alerts.filter((alert) => alert.status === 'open');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pb-4">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing the orchestrator thinks you need to act on.
          </p>
        ) : (
          open.map((alert) => (
            <div key={alert.id} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={alert.severity} />
                  <span className="font-medium">{alert.title}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {alert.at.toLocaleString()}
                </span>
              </div>
              <p className="mt-2 text-sm">{alert.summary}</p>
              {alert.investigation && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {alert.investigation}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {alert.entities.map((entity) => (
                  <span key={entity} className="rounded bg-level1 px-2 py-0.5 font-mono text-xs">
                    {entity}
                  </span>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pendingId === alert.id}
                  onClick={() => onSetStatus(alert.id, 'acknowledged')}
                >
                  Acknowledge
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pendingId === alert.id}
                  onClick={() => onSetStatus(alert.id, 'dismissed')}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
