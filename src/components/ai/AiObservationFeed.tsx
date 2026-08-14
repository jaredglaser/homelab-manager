import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SeverityBadge } from '@/components/ai/SeverityBadge';
import type { AiObservation } from '@/types/ai';

export function AiObservationFeed({ observations }: Readonly<{ observations: AiObservation[] }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Observations</CardTitle>
      </CardHeader>
      <CardContent className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto pb-4">
        {observations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing filed yet. Analysts stay silent on routine batches by design.
          </p>
        ) : (
          observations.map((observation) => (
            <div key={observation.id} className="border-b border-border pb-3 last:border-b-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={observation.severity} />
                  <span className="text-sm font-medium">{observation.title}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {observation.at.toLocaleTimeString()}
                </span>
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {observation.host}/{observation.containerKey}
              </p>
              <p className="mt-1 text-sm">{observation.detail}</p>
              {observation.evidence.length > 0 && (
                <pre className="mt-2 overflow-x-auto rounded bg-level1 p-2 font-mono text-xs">
                  {observation.evidence.join('\n')}
                </pre>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
