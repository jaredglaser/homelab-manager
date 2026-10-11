import { describe, it, expect } from 'bun:test';
import {
  getStackDetailSchema,
  triggerDeploySchema,
  getDeployHistorySchema,
  saveComposeFileSchema,
  controlStackSchema,
  resolveDriftSchema,
} from '../schemas';

describe('getStackDetailSchema', () => {
  it('accepts valid stackName', () => {
    expect(getStackDetailSchema.parse({ stackName: 'nginx' }).stackName).toBe('nginx');
  });

  it('rejects empty stackName', () => {
    expect(() => getStackDetailSchema.parse({ stackName: '' })).toThrow();
  });

  it('accepts stackName with hyphens and underscores', () => {
    expect(getStackDetailSchema.parse({ stackName: 'my-stack_v2' }).stackName).toBe('my-stack_v2');
  });

  it('rejects stackName with dots', () => {
    expect(() => getStackDetailSchema.parse({ stackName: 'my-stack.v2' })).toThrow();
  });

  it('rejects stackName with slashes (path traversal)', () => {
    expect(() => getStackDetailSchema.parse({ stackName: '../etc' })).toThrow();
    expect(() => getStackDetailSchema.parse({ stackName: 'foo/bar' })).toThrow();
    expect(() => getStackDetailSchema.parse({ stackName: '..' })).toThrow();
  });

  it('rejects stackName with spaces or special chars', () => {
    expect(() => getStackDetailSchema.parse({ stackName: 'my stack' })).toThrow();
    expect(() => getStackDetailSchema.parse({ stackName: 'stack;rm' })).toThrow();
  });
});

describe('triggerDeploySchema', () => {
  it('accepts valid deploy action', () => {
    const result = triggerDeploySchema.parse({ stack: 'web', host: 'h1', action: 'deploy' });
    expect(result.action).toBe('deploy');
  });

  it('accepts all action types', () => {
    for (const action of ['deploy', 'teardown', 'update'] as const) {
      expect(triggerDeploySchema.parse({ stack: 's', host: 'h', action }).action).toBe(action);
    }
  });

  it('rejects invalid action', () => {
    expect(() => triggerDeploySchema.parse({ stack: 's', host: 'h', action: 'stop' })).toThrow();
  });

  it('rejects empty stack or host', () => {
    expect(() => triggerDeploySchema.parse({ stack: '', host: 'h', action: 'deploy' })).toThrow();
    expect(() => triggerDeploySchema.parse({ stack: 's', host: '', action: 'deploy' })).toThrow();
  });
});

describe('getDeployHistorySchema', () => {
  it('defaults limit to 20', () => {
    expect(getDeployHistorySchema.parse({ stackName: 'x' }).limit).toBe(20);
  });

  it('rejects limit out of range', () => {
    expect(() => getDeployHistorySchema.parse({ stackName: 'x', limit: 0 })).toThrow();
    expect(() => getDeployHistorySchema.parse({ stackName: 'x', limit: 101 })).toThrow();
  });

  it('rejects fractional limit', () => {
    expect(() => getDeployHistorySchema.parse({ stackName: 'x', limit: 5.5 })).toThrow();
  });
});

describe('saveComposeFileSchema', () => {
  it('accepts valid input', () => {
    const result = saveComposeFileSchema.parse({ stackName: 'app', content: 'version: "3"' });
    expect(result.content).toBe('version: "3"');
  });

  it('rejects empty content', () => {
    expect(() => saveComposeFileSchema.parse({ stackName: 'app', content: '' })).toThrow();
  });

  it('rejects empty stackName', () => {
    expect(() => saveComposeFileSchema.parse({ stackName: '', content: '' })).toThrow();
  });
});

describe('controlStackSchema', () => {
  it('accepts valid stack-scope input', () => {
    const result = controlStackSchema.parse({
      stack: 'nginx',
      host: 'server1',
      action: 'start',
      scope: 'stack',
    });
    expect(result.scope).toBe('stack');
    expect(result.action).toBe('start');
  });

  it('accepts all three actions', () => {
    for (const action of ['start', 'stop', 'restart'] as const) {
      const result = controlStackSchema.parse({ stack: 's', host: 'h', action, scope: 'stack' });
      expect(result.action).toBe(action);
    }
  });

  it('rejects unknown action', () => {
    expect(() =>
      controlStackSchema.parse({ stack: 's', host: 'h', action: 'deploy', scope: 'stack' })
    ).toThrow();
  });

  it('accepts valid service-scope input', () => {
    const result = controlStackSchema.parse({
      stack: 'nginx',
      host: 'server1',
      action: 'restart',
      scope: 'service',
      service: 'web',
    });
    expect(result.scope).toBe('service');
    if (result.scope === 'service') {
      expect(result.service).toBe('web');
    }
  });

  it('rejects service-scope without service field', () => {
    expect(() =>
      controlStackSchema.parse({ stack: 's', host: 'h', action: 'start', scope: 'service' })
    ).toThrow();
  });

  it('rejects invalid scope', () => {
    expect(() =>
      controlStackSchema.parse({ stack: 's', host: 'h', action: 'start', scope: 'container' })
    ).toThrow();
  });

  it('rejects stack name with path traversal characters', () => {
    expect(() =>
      controlStackSchema.parse({ stack: '../etc', host: 'h', action: 'start', scope: 'stack' })
    ).toThrow();
    expect(() =>
      controlStackSchema.parse({ stack: 'foo/bar', host: 'h', action: 'start', scope: 'stack' })
    ).toThrow();
  });

  it('rejects stack name starting with underscore or hyphen', () => {
    expect(() =>
      controlStackSchema.parse({ stack: '_mystack', host: 'h', action: 'start', scope: 'stack' })
    ).toThrow();
    expect(() =>
      controlStackSchema.parse({ stack: '-mystack', host: 'h', action: 'start', scope: 'stack' })
    ).toThrow();
  });

  it('rejects invalid service name', () => {
    expect(() =>
      controlStackSchema.parse({ stack: 's', host: 'h', action: 'start', scope: 'service', service: '--help' })
    ).toThrow();
    expect(() =>
      controlStackSchema.parse({ stack: 's', host: 'h', action: 'start', scope: 'service', service: '' })
    ).toThrow();
  });

  it('rejects empty host', () => {
    expect(() =>
      controlStackSchema.parse({ stack: 's', host: '', action: 'start', scope: 'stack' })
    ).toThrow();
  });
});

describe('resolveDriftSchema', () => {
  const valid = { stack: 'plex', host: 'alpha', kind: 'untracked', resolution: 'remove' };

  it('accepts every drift kind and resolution pair', () => {
    for (const kind of ['ghost', 'untracked', 'content'] as const) {
      for (const resolution of ['trust_repo', 'trust_agent', 'remove'] as const) {
        expect(resolveDriftSchema.parse({ ...valid, kind, resolution })).toEqual({ ...valid, kind, resolution });
      }
    }
  });

  it('rejects an unknown resolution', () => {
    expect(() => resolveDriftSchema.parse({ ...valid, resolution: 'wipe' })).toThrow();
  });

  it('rejects an unknown drift kind', () => {
    expect(() => resolveDriftSchema.parse({ ...valid, kind: 'missing' })).toThrow();
  });

  it('rejects a stack name that escapes its directory', () => {
    expect(() => resolveDriftSchema.parse({ ...valid, stack: '../etc' })).toThrow();
  });

  it('rejects an empty host', () => {
    expect(() => resolveDriftSchema.parse({ ...valid, host: '' })).toThrow();
  });
});
