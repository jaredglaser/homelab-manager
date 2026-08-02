import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MockEventSource } from '@/lib/test/mock-event-source';
import { useAnsibleRun } from '@/hooks/useAnsibleRun';

const originalEventSource = globalThis.EventSource;

function send(payload: unknown): void {
  act(() => {
    MockEventSource.instances[0].onmessage?.({ data: JSON.stringify(payload) });
  });
}

function started(runId = 'run-1', checkMode = false) {
  return { type: 'run_started', runId, playbook: 'host_baseline.yml', hosts: ['host-a'], checkMode };
}

function event(runId: string, payload: Record<string, unknown>) {
  return { type: 'run_event', runId, event: payload };
}

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

describe('useAnsibleRun', () => {
  it('subscribes to the ansible-runs channel and starts empty', () => {
    const { result } = renderHook(() => useAnsibleRun());
    expect(MockEventSource.instances[0].url).toBe('/api/ansible-runs');
    expect(result.current).toMatchObject({
      runId: null,
      status: null,
      checkMode: false,
      lines: [],
      summaries: [],
    });
  });

  it('adopts a started run and renders play, task, and host lines', () => {
    const { result } = renderHook(() => useAnsibleRun());
    send(started('run-1', true));
    send(event('run-1', { kind: 'play_start', counter: 1, play: 'Host baseline' }));
    send(event('run-1', { kind: 'task_start', counter: 2, task: 'Install', action: 'package' }));
    send(event('run-1', { kind: 'host_result', counter: 3, host: 'host-a', task: 'Install', outcome: 'changed' }));

    expect(result.current.runId).toBe('run-1');
    expect(result.current.checkMode).toBe(true);
    expect(result.current.status).toBe('running');
    expect(result.current.lines.map((l) => [l.label, l.detail])).toEqual([
      ['PLAY Host baseline', null],
      ['TASK Install', 'package'],
      ['  host-a', 'changed'],
    ]);
  });

  it('records summaries and status without adding output lines for them', () => {
    const { result } = renderHook(() => useAnsibleRun());
    send(started());
    send(
      event('run-1', {
        kind: 'stats',
        counter: 4,
        summaries: [
          { host: 'host-a', ok: 2, changed: 1, failures: 0, unreachable: 0, skipped: 0, outcome: 'changed' },
        ],
      }),
    );
    send(event('run-1', { kind: 'status', counter: 5, status: 'running' }));

    expect(result.current.summaries).toHaveLength(1);
    expect(result.current.lines).toHaveLength(0);
  });

  it('applies the terminal status from run_finished', () => {
    const { result } = renderHook(() => useAnsibleRun());
    send(started());
    send({ type: 'run_finished', runId: 'run-1', status: 'failed' });
    expect(result.current.status).toBe('failed');
  });

  it('ignores events belonging to a run it is not following', () => {
    const { result } = renderHook(() => useAnsibleRun());
    send(started('run-1'));
    send(event('run-2', { kind: 'play_start', counter: 1, play: 'Other' }));
    send({ type: 'run_finished', runId: 'run-2', status: 'failed' });

    expect(result.current.lines).toHaveLength(0);
    expect(result.current.status).toBe('running');
  });

  it('resets the view when a newer run starts', () => {
    const { result } = renderHook(() => useAnsibleRun());
    send(started('run-1'));
    send(event('run-1', { kind: 'play_start', counter: 1, play: 'Host baseline' }));
    send({ type: 'run_finished', runId: 'run-1', status: 'succeeded' });
    send(started('run-2'));

    expect(result.current.runId).toBe('run-2');
    expect(result.current.status).toBe('running');
    expect(result.current.lines).toHaveLength(0);
  });

  it('caps the retained output at 500 lines', () => {
    const { result } = renderHook(() => useAnsibleRun());
    send(started());
    for (let counter = 0; counter < 505; counter++) {
      send(event('run-1', { kind: 'play_start', counter, play: `play-${counter}` }));
    }

    expect(result.current.lines).toHaveLength(500);
    expect(result.current.lines[0].label).toBe('PLAY play-5');
  });

  it('surfaces the channel error event', () => {
    const { result } = renderHook(() => useAnsibleRun());
    act(() => {
      MockEventSource.instances[0].fireEvent('ansible_runs_error', { data: '{}' });
    });
    expect(result.current.error?.message).toBe('Ansible run stream unavailable');
  });
});
