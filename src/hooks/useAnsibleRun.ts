import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSseChannel } from '@/hooks/useSseChannel';
import { getLatestAnsibleRun } from '@/data/ansible/functions';
import { ansibleRunsChannel, type AnsibleRunSSEMessage } from '@/lib/sse/channels/ansible-runs';
import type {
  AnsibleHostSummary,
  AnsibleRunEvent,
  AnsibleRunStatus,
} from '@/types/ansible';

export interface AnsibleTaskLine {
  key: string;
  label: string;
  detail: string | null;
}

export interface UseAnsibleRunResult {
  runId: string | null;
  status: AnsibleRunStatus | null;
  checkMode: boolean;
  lines: AnsibleTaskLine[];
  summaries: AnsibleHostSummary[];
  isConnected: boolean;
  error: Error | null;
}

function lineFor(runId: string, event: AnsibleRunEvent): AnsibleTaskLine | null {
  const key = `${runId}:${event.kind}:${event.counter}`;

  if (event.kind === 'play_start') return { key, label: `PLAY ${event.play}`, detail: null };
  if (event.kind === 'task_start') return { key, label: `TASK ${event.task}`, detail: event.action };
  if (event.kind === 'host_result') {
    return { key: `${key}:${event.host}`, label: `  ${event.host}`, detail: event.outcome };
  }
  return null;
}

/**
 * Follows the newest run, seeded from `ansible_run_events` so a reload, a second tab, or a
 * server restart mid-run shows the run so far instead of an empty panel. A new `run_started`
 * resets the view.
 */
export function useAnsibleRun(): UseAnsibleRunResult {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<AnsibleRunStatus | null>(null);
  const [checkMode, setCheckMode] = useState(false);
  const [lines, setLines] = useState<AnsibleTaskLine[]>([]);
  const [summaries, setSummaries] = useState<AnsibleHostSummary[]>([]);
  const activeRunId = useRef<string | null>(null);
  const seenKeys = useRef(new Set<string>());

  const preload = useQuery({
    queryKey: ['ansible', 'latest-run'],
    queryFn: () => getLatestAnsibleRun(),
    staleTime: Infinity,
  });

  useEffect(() => {
    const detail = preload.data;
    // A frame that arrived while the preload was in flight owns the view; replacing it
    // here would drop those events, since the snapshot predates them.
    if (!detail || activeRunId.current !== null) return;

    activeRunId.current = detail.run.runId;
    setRunId(detail.run.runId);
    setCheckMode(detail.run.checkMode);
    setStatus(detail.run.status);
    setSummaries(detail.run.summaries);

    const seeded: AnsibleTaskLine[] = [];
    for (const event of detail.events) {
      if (event.kind === 'stats') setSummaries(event.summaries);
      const line = lineFor(detail.run.runId, event);
      if (line && !seenKeys.current.has(line.key)) {
        seenKeys.current.add(line.key);
        seeded.push(line);
      }
    }
    setLines(seeded);
  }, [preload.data]);

  const onData = useCallback((message: AnsibleRunSSEMessage) => {
    if (message.type === 'run_started') {
      activeRunId.current = message.runId;
      seenKeys.current = new Set();
      setRunId(message.runId);
      setCheckMode(message.checkMode);
      setStatus('running');
      setLines([]);
      setSummaries([]);
      return;
    }

    if (message.runId !== activeRunId.current) return;

    if (message.type === 'run_finished') {
      setStatus(message.status);
      return;
    }

    if (message.event.kind === 'stats') {
      setSummaries(message.event.summaries);
      return;
    }
    if (message.event.kind === 'status') {
      setStatus(message.event.status);
      return;
    }

    const line = lineFor(message.runId, message.event);
    if (!line || seenKeys.current.has(line.key)) return;
    seenKeys.current.add(line.key);
    setLines((prev) => [...prev, line]);
  }, []);

  const { isConnected, error } = useSseChannel(ansibleRunsChannel, {
    onData,
    serviceErrorMessage: 'Ansible run stream unavailable',
  });

  return { runId, status, checkMode, lines, summaries, isConnected, error };
}
