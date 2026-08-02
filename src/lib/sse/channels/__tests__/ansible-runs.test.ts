import { describe, it, expect } from 'bun:test';
import {
  ansibleRunsChannel,
  serializeAnsibleRunEvent,
} from '@/lib/sse/channels/ansible-runs';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';

describe('ansibleRunsChannel', () => {
  it('names the route and error event the server route uses', () => {
    expect(ansibleRunsChannel.url).toBe('/api/ansible-runs');
    expect(ansibleRunsChannel.errorEvent).toBe('ansible_runs_error');
    expect(ansibleRunsChannel.revive).toBeUndefined();
  });

  it('accepts every broadcast shape the service emits', () => {
    const messages: AnsibleBroadcastEvent[] = [
      { type: 'run_started', runId: 'r', playbook: 'p.yml', hosts: ['host-a'], checkMode: true },
      { type: 'run_event', runId: 'r', event: { kind: 'play_start', counter: 1, play: 'baseline' } },
      { type: 'run_event', runId: 'r', event: { kind: 'task_start', counter: 2, task: 't', action: null } },
      {
        type: 'run_event',
        runId: 'r',
        event: { kind: 'host_result', counter: 3, host: 'host-a', task: null, outcome: 'skipped' },
      },
      {
        type: 'run_event',
        runId: 'r',
        event: {
          kind: 'stats',
          counter: 4,
          summaries: [
            { host: 'host-a', ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0, outcome: 'ok' },
          ],
        },
      },
      { type: 'run_event', runId: 'r', event: { kind: 'status', counter: 5, status: 'running' } },
      { type: 'run_finished', runId: 'r', status: 'succeeded' },
    ];

    for (const message of messages) {
      const frame = serializeAnsibleRunEvent(message);
      expect(frame.startsWith('data: ')).toBe(true);
      expect(frame.endsWith('\n\n')).toBe(true);
      expect(ansibleRunsChannel.schema.safeParse(JSON.parse(frame.slice(6))).success).toBe(true);
    }
  });

  it('rejects an unknown message type and an unknown event kind', () => {
    expect(ansibleRunsChannel.schema.safeParse({ type: 'run_exploded', runId: 'r' }).success).toBe(false);
    expect(
      ansibleRunsChannel.schema.safeParse({
        type: 'run_event',
        runId: 'r',
        event: { kind: 'verbose', counter: 1 },
      }).success,
    ).toBe(false);
  });
});
