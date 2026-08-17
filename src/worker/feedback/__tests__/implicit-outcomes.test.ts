import { describe, expect, it } from 'bun:test';
import type { ImplicitCandidate } from '@/lib/database/repositories/finding-label-repository';
import {
  coefficientOfVariation,
  DEFAULT_IMPLICIT_CONFIG,
  detectPeriodicRestart,
  type ContainerEventFact,
  type DeployFact,
  type EntityTimeline,
  type ImplicitOutcomeConfig,
  inferImplicitLabels,
  loadImplicitOutcomeConfig,
} from '../implicit-outcomes';

const LAST_SEEN_AT = new Date('2026-08-09T12:00:00.000Z');
const LAST_SEEN_MS = LAST_SEEN_AT.getTime();

function makeCandidate(overrides: Partial<ImplicitCandidate> = {}): ImplicitCandidate {
  return {
    findingId: 1,
    subjectKind: 'stack',
    subjectId: 'hostA/myapp',
    entityIds: ['hostA/container1'],
    host: 'hostA',
    stackProject: 'myapp',
    severity: 'warning',
    status: 'open',
    title: 'Something broke',
    detail: 'connection refused repeatedly',
    lastSeenAt: LAST_SEEN_AT,
    windowFrom: new Date(LAST_SEEN_MS - 5 * 60 * 1000),
    windowTo: LAST_SEEN_AT,
    evaluatedSignals: [],
    ...overrides,
  };
}

function makeTimeline(overrides: Partial<EntityTimeline> = {}): EntityTimeline {
  return {
    entityId: 'hostA/container1',
    events: [],
    deploys: [],
    restartTimestamps7d: [],
    deployCount7d: 0,
    medianLifetimeMs: null,
    hostRestartTimestamps7d: [],
    openFindingIdsOnEntity: [1],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ContainerEventFact> = {}): ContainerEventFact {
  return {
    at: LAST_SEEN_MS + 60_000,
    state: 'running',
    eventType: 'upsert',
    exitCode: null,
    startedAt: LAST_SEEN_MS + 60_000,
    containerId: 'container1',
    host: 'hostA',
    ...overrides,
  };
}

function makeDeploy(overrides: Partial<DeployFact> = {}): DeployFact {
  return {
    id: 100,
    at: LAST_SEEN_MS + 60_000,
    action: 'deploy',
    status: 'succeeded',
    trigger: 'git_push',
    stack: 'myapp',
    host: 'hostA',
    ...overrides,
  };
}

const config: ImplicitOutcomeConfig = DEFAULT_IMPLICIT_CONFIG;

function afterActionWindow(extraMs = 0): Date {
  return new Date(LAST_SEEN_MS + config.actionWindowMs + 5 * 60 * 1000 + extraMs);
}

function afterDeployWindow(extraMs = 0): Date {
  return new Date(LAST_SEEN_MS + config.deployWindowMs + 5 * 60 * 1000 + extraMs);
}

function afterQuietWindow(extraMs = 0): Date {
  return new Date(LAST_SEEN_MS + config.quietWindowMs + 5 * 60 * 1000 + extraMs);
}

describe('inferImplicitLabels: rollback_after', () => {
  it('fires actionable with base weight 0.40 when a manual rollback follows within the deploy window', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ id: 55, trigger: 'manual_rollback', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());
    const rollback = labels.find((l) => l.signal === 'rollback_after');

    expect(rollback).toBeDefined();
    expect(rollback?.verdict).toBe('actionable');
    expect(rollback?.weight).toBe(0.4);
    expect(rollback?.confounders).toEqual([]);
    expect(rollback?.evidence[0]?.kind).toBe('deploy');
    expect(rollback?.evidence[0]?.ref).toBe('55');
    expect(rollback?.basisAt).toEqual(LAST_SEEN_AT);
  });

  it('the strongest signal is dampened to 0.10 by multiple_candidate_findings when another open finding shares the entity', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ trigger: 'manual_rollback', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy], openFindingIdsOnEntity: [1, 2] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());
    const rollback = labels.find((l) => l.signal === 'rollback_after');

    expect(rollback?.weight).toBe(0.1);
    expect(rollback?.confounders).toContain('multiple_candidate_findings');
  });

  it('never fires when the finding has no stack context (stackProject null)', () => {
    const candidate = makeCandidate({ subjectKind: 'container', stackProject: null });
    const deploy = makeDeploy({ trigger: 'manual_rollback', stack: 'myapp', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels.find((l) => l.signal === 'rollback_after')).toBeUndefined();
  });

  it('does not fire before the finding has settled past the deploy window', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ trigger: 'manual_rollback', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, new Date(LAST_SEEN_MS + 30 * 60 * 1000));

    expect(labels.find((l) => l.signal === 'rollback_after')).toBeUndefined();
  });

  it('skips a signal already recorded for this basis_at (sweeper idempotency)', () => {
    const candidate = makeCandidate({ evaluatedSignals: ['rollback_after'] });
    const deploy = makeDeploy({ trigger: 'manual_rollback', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels.find((l) => l.signal === 'rollback_after')).toBeUndefined();
  });
});

describe('inferImplicitLabels: nonzero_exit_after', () => {
  it('fires actionable with base weight 0.35 on an unexplained nonzero exit', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS + 60_000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const exit = labels.find((l) => l.signal === 'nonzero_exit_after');

    expect(exit?.verdict).toBe('actionable');
    expect(exit?.weight).toBe(0.35);
    expect(exit?.confounders).toEqual([]);
  });

  it.each([0, 130, 143])('excludes clean exit code %d entirely', (exitCode) => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode, at: LAST_SEEN_MS + 60_000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());

    expect(labels.find((l) => l.signal === 'nonzero_exit_after')).toBeUndefined();
  });

  it('includes exit code 137 but flags sigkill_ambiguous and dampens to 0.10', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 137, at: LAST_SEEN_MS + 60_000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const exit = labels.find((l) => l.signal === 'nonzero_exit_after');

    expect(exit?.confounders).toEqual(['sigkill_ambiguous']);
    expect(exit?.weight).toBe(0.1);
  });

  it('flags short_lived_container and dampens when the container median lifetime is under 5 minutes', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS + 60_000 });
    const timeline = makeTimeline({ events: [event], medianLifetimeMs: 2 * 60 * 1000 });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const exit = labels.find((l) => l.signal === 'nonzero_exit_after');

    expect(exit?.confounders).toEqual(['short_lived_container']);
    expect(exit?.weight).toBe(0.1);
  });

  it('the label attaches to whatever finding is open even when the exit is coincidental, and flags multiple_candidate_findings when another finding is eligible for the same event', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS + 60_000 });
    const timeline = makeTimeline({ events: [event], openFindingIdsOnEntity: [1, 7] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const exit = labels.find((l) => l.signal === 'nonzero_exit_after');

    expect(exit?.confounders).toContain('multiple_candidate_findings');
    expect(exit?.weight).toBe(0.1);
  });
});

describe('inferImplicitLabels: restart_after', () => {
  it('fires actionable with base weight 0.25 and always carries operator_may_have_acted', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'running', startedAt: LAST_SEEN_MS + 2 * 60 * 1000, at: LAST_SEEN_MS + 2 * 60 * 1000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const restart = labels.find((l) => l.signal === 'restart_after');

    expect(restart?.verdict).toBe('actionable');
    expect(restart?.weight).toBe(0.25);
    expect(restart?.confounders).toEqual(['operator_may_have_acted']);
  });

  it('requires the new started_at to be later than the one in force at last_seen_at', () => {
    const candidate = makeCandidate();
    const priorRunning = makeEvent({ state: 'running', startedAt: LAST_SEEN_MS - 60 * 60 * 1000, at: LAST_SEEN_MS - 30 * 60 * 1000 });
    const sameStart = makeEvent({
      state: 'running',
      startedAt: LAST_SEEN_MS - 60 * 60 * 1000,
      at: LAST_SEEN_MS + 60_000,
    });
    const timeline = makeTimeline({ events: [priorRunning, sameStart] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());

    expect(labels.find((l) => l.signal === 'restart_after')).toBeUndefined();
  });

  it('cadence: three or more restarts in 7 days with low coefficient of variation flags periodic_restart and dampens to 0.05', () => {
    const candidate = makeCandidate();
    const restartAt = LAST_SEEN_MS + 2 * 60 * 1000;
    const event = makeEvent({ state: 'running', startedAt: restartAt, at: restartAt });
    const dayMs = 24 * 60 * 60 * 1000;
    const timeline = makeTimeline({
      events: [event],
      restartTimestamps7d: [restartAt - 3 * dayMs, restartAt - 2 * dayMs, restartAt - dayMs, restartAt],
    });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const restart = labels.find((l) => l.signal === 'restart_after');

    expect(restart?.confounders).toContain('periodic_restart');
    expect(restart?.weight).toBe(0.05);
  });

  it('irregular restart cadence does not flag periodic_restart', () => {
    const timestamps = detectPeriodicRestart(
      [0, 60_000, 5 * 60_000, 6 * 60_000, 4 * 60 * 60 * 1000],
      DEFAULT_IMPLICIT_CONFIG,
    );
    expect(timestamps).toBe(false);
  });

  it('a host reboot (three-plus containers restarting within 5 minutes) flags host_wide_event and dampens to 0.05', () => {
    const candidate = makeCandidate();
    const restartAt = LAST_SEEN_MS + 2 * 60 * 1000;
    const event = makeEvent({ state: 'running', startedAt: restartAt, at: restartAt });
    const timeline = makeTimeline({
      events: [event],
      hostRestartTimestamps7d: [restartAt, restartAt + 60_000, restartAt + 90_000],
    });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    const restart = labels.find((l) => l.signal === 'restart_after');

    expect(restart?.confounders).toContain('host_wide_event');
    expect(restart?.weight).toBe(0.05);
  });

  it('is suppressed entirely when redeploy_after fires for the same physical event', () => {
    const candidate = makeCandidate();
    const restartAt = LAST_SEEN_MS + 2 * 60 * 1000;
    const event = makeEvent({ state: 'running', startedAt: restartAt, at: restartAt });
    const deploy = makeDeploy({ action: 'deploy', status: 'succeeded', at: LAST_SEEN_MS + 90_000 });
    const timeline = makeTimeline({ events: [event], deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels.find((l) => l.signal === 'restart_after')).toBeUndefined();
    expect(labels.find((l) => l.signal === 'redeploy_after')).toBeDefined();
  });

  it('stays suppressed across a two-tick sweep where the action window settles before the deploy window', () => {
    const candidate = makeCandidate();
    const restartAt = LAST_SEEN_MS + 2 * 60 * 1000;
    const event = makeEvent({ state: 'running', startedAt: restartAt, at: restartAt });
    const deploy = makeDeploy({ action: 'deploy', status: 'succeeded', at: LAST_SEEN_MS + 90_000 });
    const timeline = makeTimeline({ events: [event], deploys: [deploy] });

    const tick1 = inferImplicitLabels(candidate, timeline, config, afterActionWindow());
    expect(tick1.find((l) => l.signal === 'restart_after')).toBeUndefined();
    expect(tick1.find((l) => l.signal === 'redeploy_after')).toBeUndefined();

    const tick2 = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());
    expect(tick2.find((l) => l.signal === 'restart_after')).toBeUndefined();
    expect(tick2.find((l) => l.signal === 'redeploy_after')).toBeDefined();
  });
});

describe('inferImplicitLabels: redeploy_after', () => {
  it('fires actionable with base weight 0.20 on a succeeded deploy or update', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ action: 'update', status: 'succeeded', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());
    const redeploy = labels.find((l) => l.signal === 'redeploy_after');

    expect(redeploy?.verdict).toBe('actionable');
    expect(redeploy?.weight).toBe(0.2);
  });

  it('a CI push unrelated to the fault is wrong most of the time on an active stack: frequent_deploys dampens to 0.05', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ action: 'deploy', status: 'succeeded', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy], deployCount7d: 6 });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());
    const redeploy = labels.find((l) => l.signal === 'redeploy_after');

    expect(redeploy?.confounders).toContain('frequent_deploys');
    expect(redeploy?.weight).toBe(0.05);
  });

  it('ignores a failed deploy attempt', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ action: 'deploy', status: 'failed', at: LAST_SEEN_MS + 10 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels.find((l) => l.signal === 'redeploy_after')).toBeUndefined();
  });
});

describe('inferImplicitLabels: quiet_24h', () => {
  it('fires noise with weight 0.15 when nothing happens for 24 hours', () => {
    const candidate = makeCandidate();
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());
    const quiet = labels.find((l) => l.signal === 'quiet_24h');

    expect(quiet?.verdict).toBe('noise');
    expect(quiet?.weight).toBe(0.15);
  });

  it('is never written for a critical-severity finding, however quiet the window', () => {
    const candidate = makeCandidate({ severity: 'critical' });
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());

    expect(labels.find((l) => l.signal === 'quiet_24h')).toBeUndefined();
  });

  it('does not fire once the finding has already left the open state', () => {
    const candidate = makeCandidate({ status: 'dismissed' });
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());

    expect(labels.find((l) => l.signal === 'quiet_24h')).toBeUndefined();
  });

  it('is disqualified by any container activity inside the 24h window (the container did not stay untouched)', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 0, at: LAST_SEEN_MS + 5 * 60 * 60 * 1000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());

    expect(labels.find((l) => l.signal === 'quiet_24h')).toBeUndefined();
  });

  it('is disqualified by a deploy inside the 24h window even without a matching stack context', () => {
    const candidate = makeCandidate();
    const deploy = makeDeploy({ at: LAST_SEEN_MS + 5 * 60 * 60 * 1000 });
    const timeline = makeTimeline({ deploys: [deploy] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());

    expect(labels.find((l) => l.signal === 'quiet_24h')).toBeUndefined();
  });

  it('flags slow_burn_candidate as a labelled heuristic without dampening the weight (a slow-burn fault may still be real)', () => {
    const candidate = makeCandidate({ title: 'Disk usage climbing', detail: 'disk filling at 2% a day' });
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());
    const quiet = labels.find((l) => l.signal === 'quiet_24h');

    expect(quiet?.confounders).toEqual(['slow_burn_candidate']);
    expect(quiet?.weight).toBe(0.15);
  });
});

describe('inferImplicitLabels: no_outcome_observed', () => {
  it('records inconclusive once settled past the longest positive window when nothing else fired', () => {
    const candidate = makeCandidate();
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels).toHaveLength(1);
    expect(labels[0]?.signal).toBe('no_outcome_observed');
    expect(labels[0]?.verdict).toBe('inconclusive');
    expect(labels[0]?.weight).toBe(0.05);
  });

  it('does not fire in the same evaluation where quiet_24h fires', () => {
    const candidate = makeCandidate();
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());

    expect(labels.find((l) => l.signal === 'quiet_24h')).toBeDefined();
    expect(labels.find((l) => l.signal === 'no_outcome_observed')).toBeUndefined();
  });

  it('does not fire when a signal already recorded on a prior tick for this basis_at (distinguishes "saw nothing" from "never evaluated")', () => {
    const candidate = makeCandidate({ evaluatedSignals: ['nonzero_exit_after'] });
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels.find((l) => l.signal === 'no_outcome_observed')).toBeUndefined();
  });

  it('is itself idempotent per basis_at', () => {
    const candidate = makeCandidate({ evaluatedSignals: ['no_outcome_observed'] });
    const timeline = makeTimeline();

    const labels = inferImplicitLabels(candidate, timeline, config, afterDeployWindow());

    expect(labels).toHaveLength(0);
  });
});

describe('inferImplicitLabels: timing discipline', () => {
  it('ignores an event at or before last_seen_at (it is the probable cause, not an outcome)', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());

    expect(labels.find((l) => l.signal === 'nonzero_exit_after')).toBeUndefined();
  });

  it('excludes an event inside [window_from, window_to] even if it is after last_seen_at', () => {
    const windowTo = new Date(LAST_SEEN_MS + 30_000);
    const candidate = makeCandidate({ windowTo });
    const event = makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS + 15_000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow());

    expect(labels.find((l) => l.signal === 'nonzero_exit_after')).toBeUndefined();
  });

  it('ignores an event past the rule window', () => {
    const candidate = makeCandidate();
    const event = makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS + config.actionWindowMs + 60_000 });
    const timeline = makeTimeline({ events: [event] });

    const labels = inferImplicitLabels(candidate, timeline, config, afterActionWindow(10 * 60 * 1000));

    expect(labels.find((l) => l.signal === 'nonzero_exit_after')).toBeUndefined();
  });
});

describe('inferImplicitLabels: invariant - implicit labels never outrank an operator verdict', () => {
  it('every emitted weight stays at or below the 0.5 ceiling reserved for non-operator sources', () => {
    const candidate = makeCandidate({ severity: 'info' });
    const restartAt = LAST_SEEN_MS + 60_000;
    const timeline = makeTimeline({
      events: [
        makeEvent({ state: 'running', startedAt: restartAt, at: restartAt }),
        makeEvent({ state: 'exited', exitCode: 1, at: LAST_SEEN_MS + 90_000 }),
      ],
      deploys: [
        makeDeploy({ trigger: 'manual_rollback', at: LAST_SEEN_MS + 90_000 }),
        makeDeploy({ action: 'update', status: 'succeeded', at: LAST_SEEN_MS + 90_000 }),
      ],
    });

    const labels = inferImplicitLabels(candidate, timeline, config, afterQuietWindow());

    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.weight).toBeGreaterThan(0);
      expect(label.weight).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('coefficientOfVariation', () => {
  it('returns 0 for an empty input', () => {
    expect(coefficientOfVariation([])).toBe(0);
  });

  it('returns 0 when the mean is 0', () => {
    expect(coefficientOfVariation([0, 0, 0])).toBe(0);
  });

  it('returns 0 for perfectly regular intervals', () => {
    expect(coefficientOfVariation([1000, 1000, 1000])).toBe(0);
  });

  it('returns a positive value proportional to spread for irregular intervals', () => {
    const cv = coefficientOfVariation([1000, 5000, 100]);
    expect(cv).toBeGreaterThan(0.25);
  });
});

describe('detectPeriodicRestart', () => {
  it('returns false below the minimum sample count', () => {
    expect(detectPeriodicRestart([0, 60_000], DEFAULT_IMPLICIT_CONFIG)).toBe(false);
  });

  it('returns true for evenly spaced restarts at or above the minimum count', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    expect(detectPeriodicRestart([0, dayMs, 2 * dayMs, 3 * dayMs], DEFAULT_IMPLICIT_CONFIG)).toBe(true);
  });

  it('returns false for widely varying spacing', () => {
    expect(detectPeriodicRestart([0, 60_000, 5 * 60 * 60 * 1000], DEFAULT_IMPLICIT_CONFIG)).toBe(false);
  });
});

describe('loadImplicitOutcomeConfig', () => {
  it('falls back to the documented defaults with no env overrides', () => {
    const result = loadImplicitOutcomeConfig({});
    expect(result).toEqual(DEFAULT_IMPLICIT_CONFIG);
  });

  it('reads the three configurable windows from the environment', () => {
    const result = loadImplicitOutcomeConfig({
      FEEDBACK_ACTION_WINDOW_MS: '600000',
      FEEDBACK_DEPLOY_WINDOW_MS: '1800000',
      FEEDBACK_QUIET_WINDOW_MS: '3600000',
    });
    expect(result.actionWindowMs).toBe(600_000);
    expect(result.deployWindowMs).toBe(1_800_000);
    expect(result.quietWindowMs).toBe(3_600_000);
  });

  it('falls back to defaults on non-positive or non-numeric overrides', () => {
    const result = loadImplicitOutcomeConfig({
      FEEDBACK_ACTION_WINDOW_MS: '-5',
      FEEDBACK_DEPLOY_WINDOW_MS: 'not-a-number',
      FEEDBACK_QUIET_WINDOW_MS: '0',
    });
    expect(result).toEqual(DEFAULT_IMPLICIT_CONFIG);
  });

  it('defaults to process.env when no argument is passed', () => {
    const result = loadImplicitOutcomeConfig();
    expect(result.actionWindowMs).toBeGreaterThan(0);
  });
});
