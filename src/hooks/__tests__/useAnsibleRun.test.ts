import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ReactNode } from 'react';
import { MockEventSource } from '@/lib/test/mock-event-source';

const getLatestAnsibleRun = mock(async (): Promise<unknown> => null);

mock.module('@/data/ansible/functions', () => ({ getLatestAnsibleRun }));

const { useAnsibleRun } = await import('@/hooks/useAnsibleRun');
const { renderHook, act, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createElement } = await import('react');

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function render() {
  return renderHook(() => useAnsibleRun(), { wrapper: makeWrapper() });
}

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
  getLatestAnsibleRun.mockClear();
  getLatestAnsibleRun.mockImplementation(async () => null);
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

describe('useAnsibleRun', () => {
  it('subscribes to the ansible-runs channel and starts empty', () => {
    const { result } = render();
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
    const { result } = render();
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
    const { result } = render();
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
    const { result } = render();
    send(started());
    send({ type: 'run_finished', runId: 'run-1', status: 'failed' });
    expect(result.current.status).toBe('failed');
  });

  it('ignores events belonging to a run it is not following', () => {
    const { result } = render();
    send(started('run-1'));
    send(event('run-2', { kind: 'play_start', counter: 1, play: 'Other' }));
    send({ type: 'run_finished', runId: 'run-2', status: 'failed' });

    expect(result.current.lines).toHaveLength(0);
    expect(result.current.status).toBe('running');
  });

  it('resets the view when a newer run starts', () => {
    const { result } = render();
    send(started('run-1'));
    send(event('run-1', { kind: 'play_start', counter: 1, play: 'Host baseline' }));
    send({ type: 'run_finished', runId: 'run-1', status: 'succeeded' });
    send(started('run-2'));

    expect(result.current.runId).toBe('run-2');
    expect(result.current.status).toBe('running');
    expect(result.current.lines).toHaveLength(0);
  });

  it('retains the whole run, including the opening lines of a long one', () => {
    const { result } = render();
    send(started());
    for (let counter = 0; counter < 505; counter++) {
      send(event('run-1', { kind: 'play_start', counter, play: `play-${counter}` }));
    }

    expect(result.current.lines).toHaveLength(505);
    expect(result.current.lines[0].label).toBe('PLAY play-0');
  });

  it('drops a duplicate frame for an event the preload already seeded', async () => {
    getLatestAnsibleRun.mockImplementation(async () => ({
      run: {
        id: 1,
        runId: 'run-1',
        playbook: 'host_baseline.yml',
        hosts: ['host-a'],
        checkMode: false,
        status: 'running',
        requestedBy: 'admin@local',
        summaries: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        finishedAt: null,
      },
      events: [{ kind: 'play_start', counter: 1, play: 'Host baseline' }],
    }));

    const { result } = render();
    await waitFor(() => expect(result.current.runId).toBe('run-1'));
    expect(result.current.lines).toHaveLength(1);

    send(event('run-1', { kind: 'play_start', counter: 1, play: 'Host baseline' }));
    send(event('run-1', { kind: 'task_start', counter: 2, task: 'Install', action: 'package' }));

    expect(result.current.lines.map((l) => l.label)).toEqual([
      'PLAY Host baseline',
      'TASK Install',
    ]);
  });

  it('lets a run that started before the preload resolved own the view', async () => {
    let release: (value: unknown) => void = () => {};
    getLatestAnsibleRun.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { result } = render();
    send(started('run-2'));
    send(event('run-2', { kind: 'play_start', counter: 1, play: 'Newer' }));

    act(() => {
      release({
        run: {
          id: 1,
          runId: 'run-1',
          playbook: 'host_baseline.yml',
          hosts: ['host-a'],
          checkMode: false,
          status: 'succeeded',
          requestedBy: 'admin@local',
          summaries: [],
          createdAt: '2026-08-04T00:00:00.000Z',
          finishedAt: '2026-08-04T00:01:00.000Z',
        },
        events: [{ kind: 'play_start', counter: 9, play: 'Stale' }],
      });
    });

    await waitFor(() => expect(getLatestAnsibleRun).toHaveBeenCalled());
    expect(result.current.runId).toBe('run-2');
    expect(result.current.lines.map((l) => l.label)).toEqual(['PLAY Newer']);
  });

  it('surfaces the channel error event', () => {
    const { result } = render();
    act(() => {
      MockEventSource.instances[0].fireEvent('ansible_runs_error', { data: '{}' });
    });
    expect(result.current.error?.message).toBe('Ansible run stream unavailable');
  });
});
