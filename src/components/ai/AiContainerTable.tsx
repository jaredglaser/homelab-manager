import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MarkdownViewerDialog } from '@/components/ai/MarkdownViewerDialog';
import type { AiAnalysisSession, AiContainerProfile, AiProfileStatus } from '@/types/ai';

const STATUS_VARIANT = {
  pending: 'outline',
  profiling: 'secondary',
  ready: 'success',
  failed: 'destructive',
} as const satisfies Record<AiProfileStatus, 'outline' | 'secondary' | 'success' | 'destructive'>;

export interface AiContainerTableProps {
  profiles: AiContainerProfile[];
  sessions: AiAnalysisSession[];
  onToggle: (host: string, containerKey: string, enabled: boolean) => void;
}

interface ViewerState {
  title: string;
  description: string;
  content: string | null;
}

/** Latest session per container, so the row shows today's progress. */
function latestSessionByEntity(sessions: AiAnalysisSession[]): Map<string, AiAnalysisSession> {
  const byEntity = new Map<string, AiAnalysisSession>();
  for (const session of sessions) {
    const entityId = `${session.host}/${session.containerKey}`;
    const existing = byEntity.get(entityId);
    if (!existing || existing.day < session.day) byEntity.set(entityId, session);
  }
  return byEntity;
}

export function AiContainerTable({ profiles, sessions, onToggle }: Readonly<AiContainerTableProps>) {
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const latest = useMemo(() => latestSessionByEntity(sessions), [sessions]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Containers</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No containers registered yet. The worker adds them as it discovers running containers.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Container</TableHead>
                <TableHead>Skill</TableHead>
                <TableHead>Today</TableHead>
                <TableHead>Report</TableHead>
                <TableHead>Watching</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => {
                const entityId = `${profile.host}/${profile.containerKey}`;
                const session = latest.get(entityId);
                return (
                  <TableRow key={entityId}>
                    <TableCell className="font-mono text-xs">{entityId}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_VARIANT[profile.status]}>{profile.status}</Badge>
                        {profile.skillMarkdown && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setViewer({
                                title: `Skill: ${entityId}`,
                                description: `v${profile.skillVersion}, written by ${profile.model ?? 'unknown model'} from ${profile.sampleLineCount} sampled lines`,
                                content: profile.skillMarkdown,
                              })
                            }
                          >
                            View
                          </Button>
                        )}
                      </div>
                      {profile.error && (
                        <span className="mt-1 block text-xs text-destructive">{profile.error}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {session
                        ? `${session.batchesProcessed} batch(es), ${session.linesProcessed} lines`
                        : '--'}
                    </TableCell>
                    <TableCell>
                      {session?.reportMarkdown ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setViewer({
                              title: `${session.day}: ${entityId}`,
                              description: `Written by ${session.model ?? 'unknown model'}`,
                              content: session.reportMarkdown,
                            })
                          }
                        >
                          {session.day}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">--</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={profile.enabled}
                        onCheckedChange={(checked) =>
                          onToggle(profile.host, profile.containerKey, checked)
                        }
                        aria-label={`Watch ${entityId}`}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <MarkdownViewerDialog
        open={viewer !== null}
        onOpenChange={(open) => !open && setViewer(null)}
        title={viewer?.title ?? ''}
        description={viewer?.description}
        content={viewer?.content ?? null}
      />
    </Card>
  );
}
