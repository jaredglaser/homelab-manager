import { describe, expect, test } from 'bun:test';
import { parseAutoUpdate, AUTO_UPDATE_ENV } from '../parse-auto-update';

describe('parseAutoUpdate', () => {
  test('unset or empty means manual by default', () => {
    expect(parseAutoUpdate(undefined)).toBe(false);
    expect(parseAutoUpdate('')).toBe(false);
  });

  test('accepts exact true/false', () => {
    expect(parseAutoUpdate('true')).toBe(true);
    expect(parseAutoUpdate('false')).toBe(false);
  });

  test('rejects anything that is not exactly true or false', () => {
    for (const bad of ['TRUE', 'True', '1', '0', 'yes', ' false', 'false ', 'on', 'enabled']) {
      expect(parseAutoUpdate(bad)).toBe(null);
    }
  });

  test('env var name is stable', () => {
    expect(AUTO_UPDATE_ENV).toBe('HLM_AUTO_UPDATE');
  });
});
