import { describe, it, expect } from 'bun:test';
import { UITriggerBuilder } from '../builders/ui-trigger-builder';

describe('UITriggerBuilder', () => {
  const builder = new UITriggerBuilder();

  describe('build', () => {
    it('creates an auto-approved deploy request with ui trigger', () => {
      const result = builder.build({
        stack: 'plex',
        host: 'homeserver',
        composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker',
        commitSha: 'abc123',
        action: 'deploy',
      });

      expect(result).toEqual({
        stack: 'plex',
        host: 'homeserver',
        composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker',
        commitSha: 'abc123',
        envContent: '',
        action: 'deploy',
        trigger: 'ui',
        autoApproved: true,
      });
    });

    it('preserves the action type (teardown)', () => {
      const result = builder.build({
        stack: 'sonarr',
        host: 'homeserver',
        composeContent: '',
        commitSha: 'def456',
        action: 'teardown',
      });

      expect(result.action).toBe('teardown');
      expect(result.trigger).toBe('ui');
      expect(result.autoApproved).toBe(true);
    });
  });

  describe('buildRollback', () => {
    it('creates an auto-approved rollback request with manual_rollback trigger', () => {
      const result = builder.buildRollback({
        stack: 'plex',
        host: 'homeserver',
        composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker:1.29',
        commitSha: 'oldsha',
      });

      expect(result).toEqual({
        stack: 'plex',
        host: 'homeserver',
        composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker:1.29',
        commitSha: 'oldsha',
        envContent: '',
        action: 'deploy',
        trigger: 'manual_rollback',
        autoApproved: true,
      });
    });
  });
});
