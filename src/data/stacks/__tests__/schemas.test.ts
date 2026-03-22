import { describe, it, expect } from 'bun:test';
import {
  getStackDetailSchema,
  triggerDeploySchema,
  getDeployHistorySchema,
  saveComposeFileSchema,
  updateStackIconSchema,
} from '../schemas';

describe('getStackDetailSchema', () => {
  it('accepts valid stackName', () => {
    expect(getStackDetailSchema.parse({ stackName: 'nginx' }).stackName).toBe('nginx');
  });

  it('rejects empty stackName', () => {
    expect(() => getStackDetailSchema.parse({ stackName: '' })).toThrow();
  });
});

describe('triggerDeploySchema', () => {
  it('accepts valid deploy action', () => {
    const result = triggerDeploySchema.parse({ stack: 'web', host: 'h1', action: 'deploy' });
    expect(result.action).toBe('deploy');
  });

  it('accepts all action types', () => {
    for (const action of ['deploy', 'teardown', 'restart'] as const) {
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
});

describe('saveComposeFileSchema', () => {
  it('accepts valid input', () => {
    const result = saveComposeFileSchema.parse({ stackName: 'app', content: 'version: "3"' });
    expect(result.content).toBe('version: "3"');
  });

  it('accepts empty content', () => {
    expect(saveComposeFileSchema.parse({ stackName: 'app', content: '' }).content).toBe('');
  });

  it('rejects empty stackName', () => {
    expect(() => saveComposeFileSchema.parse({ stackName: '', content: '' })).toThrow();
  });
});

describe('updateStackIconSchema', () => {
  it('accepts valid input', () => {
    expect(updateStackIconSchema.parse({ stackName: 'web', iconSlug: 'nginx' }).iconSlug).toBe('nginx');
  });

  it('rejects empty fields', () => {
    expect(() => updateStackIconSchema.parse({ stackName: '', iconSlug: 'x' })).toThrow();
    expect(() => updateStackIconSchema.parse({ stackName: 'x', iconSlug: '' })).toThrow();
  });
});
