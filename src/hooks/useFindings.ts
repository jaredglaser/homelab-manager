import { useCallback, useMemo, useState } from 'react';
import { useSseChannel } from '@/hooks/useSseChannel';
import { findingsChannel, type FindingsSSEMessage } from '@/lib/sse/channels/findings';
import type { Finding } from '@/lib/findings/types';

export interface UseFindingsResult {
  findings: Finding[];
  isConnected: boolean;
  error: string | null;
}

function findingsEqual(a: Finding, b: Finding): boolean {
  return (
    a.id === b.id
    && a.status === b.status
    && a.occurrences === b.occurrences
    && a.lastSeenAt.getTime() === b.lastSeenAt.getTime()
    && a.severity === b.severity
  );
}

function compareFindings(a: Finding, b: Finding): number {
  const aOpen = a.status === 'open';
  const bOpen = b.status === 'open';
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const byLastSeen = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  if (byLastSeen !== 0) return byLastSeen;
  return b.id - a.id;
}

export function useFindings(): UseFindingsResult {
  const [byId, setById] = useState<Map<number, Finding>>(new Map());

  const handleData = useCallback((data: FindingsSSEMessage) => {
    if (data.type === 'init') {
      const next = new Map<number, Finding>();
      for (const finding of data.findings) next.set(finding.id, finding);
      setById(next);
      return;
    }

    setById((prev) => {
      const existing = prev.get(data.finding.id);
      if (existing && findingsEqual(existing, data.finding)) return prev;
      const next = new Map(prev);
      next.set(data.finding.id, data.finding);
      return next;
    });
  }, []);

  const { isConnected, error } = useSseChannel(findingsChannel, {
    onData: handleData,
    serviceErrorMessage: 'Findings stream unavailable',
  });

  const findings = useMemo(() => Array.from(byId.values()).sort(compareFindings), [byId]);

  return { findings, isConnected, error: error?.message ?? null };
}
