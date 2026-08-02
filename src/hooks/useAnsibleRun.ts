import { useCallback, useRef, useState } from 'react';
import { useSseChannel } from '@/hooks/useSseChannel';
import { ansibleRunsChannel, type AnsibleRunSSEMessage } from '@/lib/sse/channels/ansible-runs';
import type { AnsibleHostSummary, AnsibleRunStatus } from '@/types/ansible';

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

const MAX_LINES = 500;

function lineFor(message: Extract<AnsibleRunSSEMessage, { type: 'run_event' }>): AnsibleTaskLine | null {
  const { event } = message;
  const key = `${message.runId}:${event.kind}:${event.counter}`;

  if (event.kind === 'play_start') return { key, label: `PLAY ${event.play}`, detail: null };
  if (event.kind === 'task_start') return { key, label: `TASK ${event.task}`, detail: event.action };
  if (event.kind === 'host_result') {
    return { key: `${key}:${event.host}`, label: `  ${event.host}`, detail: event.outcome };
  }
  return null;
}

/** Follows the newest run on the channel; a new `run_started` resets the view. */
export function useAnsibleRun(): UseAnsibleRunResult {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<AnsibleRunStatus | null>(null);
  const [checkMode, setCheckMode] = useState(false);
  const [lines, setLines] = useState<AnsibleTaskLine[]>([]);
  const [summaries, setSummaries] = useState<AnsibleHostSummary[]>([]);
  const activeRunId = useRef<string | null>(null);

  const onData = useCallback((message: AnsibleRunSSEMessage) => {
    if (message.type === 'run_started') {
      activeRunId.current = message.runId;
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

    const line = lineFor(message);
    if (line) setLines((prev) => [...prev, line].slice(-MAX_LINES));
  }, []);

  const { isConnected, error } = useSseChannel(ansibleRunsChannel, {
    onData,
    serviceErrorMessage: 'Ansible run stream unavailable',
  });

  return { runId, status, checkMode, lines, summaries, isConnected, error };
}
