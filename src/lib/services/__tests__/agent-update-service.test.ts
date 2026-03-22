import { describe, it, expect } from 'bun:test';
import { checkAgentVersion } from '../agent-update-service';

describe('checkAgentVersion', () => {
  it('reports update available when versions differ', () => {
    const result = checkAgentVersion('0.1.0', '0.2.0');
    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe('0.1.0');
    expect(result.latestVersion).toBe('0.2.0');
  });

  it('reports no update when versions match', () => {
    const result = checkAgentVersion('0.2.0', '0.2.0');
    expect(result.updateAvailable).toBe(false);
    expect(result.currentVersion).toBe('0.2.0');
    expect(result.latestVersion).toBe('0.2.0');
  });

  it('treats any version string difference as an update', () => {
    const result = checkAgentVersion('latest', '0.1.0');
    expect(result.updateAvailable).toBe(true);
  });
});
