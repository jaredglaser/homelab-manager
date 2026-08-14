import { describe, it, expect } from 'bun:test';
import { AI_DEFAULTS, maxSeverity, resolveAiSettings, severityAtLeast } from '@/lib/ai/config';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

describe('resolveAiSettings', () => {
  it('falls back to defaults for an empty settings map', () => {
    expect(resolveAiSettings({})).toEqual(AI_DEFAULTS);
  });

  it('reads every configured value', () => {
    expect(
      resolveAiSettings({
        [SETTINGS_KEYS.ai.enabled]: 'true',
        [SETTINGS_KEYS.ai.batchLines]: '500',
        [SETTINGS_KEYS.ai.maxConcurrentAgents]: '8',
        [SETTINGS_KEYS.ai.profileWindowDays]: '3',
        [SETTINGS_KEYS.ai.alertSeverity]: 'critical',
      }),
    ).toEqual({
      enabled: true,
      batchLines: 500,
      maxConcurrentAgents: 8,
      profileWindowDays: 3,
      alertSeverity: 'critical',
    });
  });

  it('treats any non-"true" enabled value as off', () => {
    expect(resolveAiSettings({ [SETTINGS_KEYS.ai.enabled]: 'yes' }).enabled).toBe(false);
    expect(resolveAiSettings({ [SETTINGS_KEYS.ai.enabled]: null }).enabled).toBe(false);
  });

  it('clamps out-of-range numbers to the allowed window', () => {
    const settings = resolveAiSettings({
      [SETTINGS_KEYS.ai.batchLines]: '999999',
      [SETTINGS_KEYS.ai.maxConcurrentAgents]: '0',
      [SETTINGS_KEYS.ai.profileWindowDays]: '900',
    });
    expect(settings.batchLines).toBe(2000);
    expect(settings.maxConcurrentAgents).toBe(1);
    expect(settings.profileWindowDays).toBe(30);
  });

  it('ignores unparseable numbers and unknown severities', () => {
    const settings = resolveAiSettings({
      [SETTINGS_KEYS.ai.batchLines]: 'lots',
      [SETTINGS_KEYS.ai.alertSeverity]: 'catastrophic',
    });
    expect(settings.batchLines).toBe(AI_DEFAULTS.batchLines);
    expect(settings.alertSeverity).toBe(AI_DEFAULTS.alertSeverity);
  });
});

describe('severityAtLeast', () => {
  it('compares against the floor inclusively', () => {
    expect(severityAtLeast('warning', 'warning')).toBe(true);
    expect(severityAtLeast('critical', 'warning')).toBe(true);
    expect(severityAtLeast('notice', 'warning')).toBe(false);
  });
});

describe('maxSeverity', () => {
  it('returns the worst of the set', () => {
    expect(maxSeverity(['info', 'critical', 'notice'])).toBe('critical');
  });

  it('returns info for an empty set', () => {
    expect(maxSeverity([])).toBe('info');
  });
});
