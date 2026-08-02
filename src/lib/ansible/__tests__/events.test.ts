import { describe, it, expect } from 'bun:test';
import {
  normalizeRunnerEvent,
  summarizeStats,
  statusFromSummaries,
} from '@/lib/ansible/events';

describe('normalizeRunnerEvent', () => {
  it('rejects non-objects and events without a name', () => {
    expect(normalizeRunnerEvent(null)).toBeNull();
    expect(normalizeRunnerEvent('nope')).toBeNull();
    expect(normalizeRunnerEvent({})).toBeNull();
    expect(normalizeRunnerEvent({ event: '' })).toBeNull();
    expect(normalizeRunnerEvent({ event: 7 })).toBeNull();
  });

  it('maps play and task starts', () => {
    expect(
      normalizeRunnerEvent({
        event: 'playbook_on_play_start',
        counter: 3,
        event_data: { play: 'Host baseline' },
      }),
    ).toEqual({ kind: 'play_start', counter: 3, play: 'Host baseline' });

    expect(
      normalizeRunnerEvent({
        event: 'playbook_on_task_start',
        counter: 4,
        event_data: { task: 'Install baseline packages', task_action: 'package' },
      }),
    ).toEqual({
      kind: 'task_start',
      counter: 4,
      task: 'Install baseline packages',
      action: 'package',
    });
  });

  it('falls back to placeholders and a null action when event_data is empty', () => {
    expect(normalizeRunnerEvent({ event: 'playbook_on_play_start', counter: 1 })).toEqual({
      kind: 'play_start',
      counter: 1,
      play: 'play',
    });
    expect(normalizeRunnerEvent({ event: 'playbook_on_task_start', counter: 2 })).toEqual({
      kind: 'task_start',
      counter: 2,
      task: 'task',
      action: null,
    });
  });

  it('treats a missing or non-finite counter as zero', () => {
    expect(normalizeRunnerEvent({ event: 'playbook_on_play_start' })?.counter).toBe(0);
    expect(
      normalizeRunnerEvent({ event: 'playbook_on_play_start', counter: Number.NaN })?.counter,
    ).toBe(0);
    expect(
      normalizeRunnerEvent({ event: 'playbook_on_play_start', counter: '5' })?.counter,
    ).toBe(0);
  });

  it('maps each per-host result event to its outcome', () => {
    const cases = [
      ['runner_on_ok', 'ok'],
      ['runner_on_failed', 'failed'],
      ['runner_on_unreachable', 'unreachable'],
      ['runner_on_skipped', 'skipped'],
    ] as const;

    for (const [event, outcome] of cases) {
      expect(
        normalizeRunnerEvent({
          event,
          counter: 9,
          event_data: { host: 'host-a', task: 'Ensure the appdata root exists' },
        }),
      ).toEqual({
        kind: 'host_result',
        counter: 9,
        host: 'host-a',
        task: 'Ensure the appdata root exists',
        outcome,
      });
    }
  });

  it('drops a host result that names no host', () => {
    expect(normalizeRunnerEvent({ event: 'runner_on_ok', counter: 1, event_data: {} })).toBeNull();
  });

  it('carries a null task when the result has no task name', () => {
    expect(
      normalizeRunnerEvent({ event: 'runner_on_ok', counter: 1, event_data: { host: 'host-a' } }),
    ).toEqual({ kind: 'host_result', counter: 1, host: 'host-a', task: null, outcome: 'ok' });
  });

  it('maps runner status frames and drops unknown statuses', () => {
    const statusFor = (status: string) =>
      normalizeRunnerEvent({ event: 'runner_status', status });

    expect(statusFor('starting')).toEqual({ kind: 'status', counter: 0, status: 'running' });
    expect(statusFor('running')).toEqual({ kind: 'status', counter: 0, status: 'running' });
    expect(statusFor('successful')).toEqual({ kind: 'status', counter: 0, status: 'succeeded' });
    expect(statusFor('failed')).toEqual({ kind: 'status', counter: 0, status: 'failed' });
    expect(statusFor('timeout')).toEqual({ kind: 'status', counter: 0, status: 'failed' });
    expect(statusFor('canceled')).toEqual({ kind: 'status', counter: 0, status: 'cancelled' });
    expect(statusFor('wat')).toBeNull();
    expect(normalizeRunnerEvent({ event: 'runner_status' })).toBeNull();
  });

  it('ignores runner events this UI has no use for', () => {
    expect(normalizeRunnerEvent({ event: 'verbose', counter: 2 })).toBeNull();
    expect(normalizeRunnerEvent({ event: 'runner_on_start', counter: 2 })).toBeNull();
  });

  it('reads only allowlisted fields, so module output cannot reach the wire', () => {
    const normalized = normalizeRunnerEvent({
      event: 'runner_on_ok',
      counter: 1,
      event_data: {
        host: 'host-a',
        task: 'Write the baseline credential',
        res: { content: 'HLM_BASELINE_TOKEN=super-secret' },
        task_args: 'content=super-secret',
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('super-secret');
  });
});

describe('summarizeStats', () => {
  it('builds one sorted summary per host mentioned in any map', () => {
    const summaries = summarizeStats({
      ok: { 'host-b': 5, 'host-a': 4 },
      changed: { 'host-a': 2 },
      failures: {},
      dark: { 'host-c': 1 },
      skipped: { 'host-b': 1 },
      processed: { 'host-a': 1, 'host-b': 1, 'host-c': 1 },
    });

    expect(summaries.map((s) => s.host)).toEqual(['host-a', 'host-b', 'host-c']);
    expect(summaries[0]).toEqual({
      host: 'host-a',
      ok: 4,
      changed: 2,
      failures: 0,
      unreachable: 0,
      skipped: 0,
      outcome: 'changed',
    });
    expect(summaries[1].outcome).toBe('ok');
    expect(summaries[2]).toMatchObject({ unreachable: 1, outcome: 'unreachable' });
  });

  it('ranks unreachable above failed, and failed above changed', () => {
    const [summary] = summarizeStats({ failures: { h: 1 }, dark: { h: 1 }, changed: { h: 1 } });
    expect(summary.outcome).toBe('unreachable');

    const [failed] = summarizeStats({ failures: { h: 1 }, changed: { h: 1 } });
    expect(failed.outcome).toBe('failed');
  });

  it('treats absent, non-object and non-numeric map entries as zero', () => {
    const [summary] = summarizeStats({ ok: { h: 'four' }, changed: null, failures: 'nope', dark: { h: 1 } });
    expect(summary).toMatchObject({ ok: 0, changed: 0, failures: 0, skipped: 0 });
  });

  it('returns nothing when no map names a host', () => {
    expect(summarizeStats({})).toEqual([]);
  });
});

describe('statusFromSummaries', () => {
  it('fails a run that produced no summaries at all', () => {
    expect(statusFromSummaries([])).toBe('failed');
  });

  it('fails only when a host actually failed, not when one was unreachable', () => {
    const base = { ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0 } as const;
    expect(
      statusFromSummaries([{ host: 'a', ...base, outcome: 'unreachable' }]),
    ).toBe('succeeded');
    expect(
      statusFromSummaries([
        { host: 'a', ...base, outcome: 'ok' },
        { host: 'b', ...base, outcome: 'failed' },
      ]),
    ).toBe('failed');
  });
});
