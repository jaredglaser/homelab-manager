import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('resolveAgentUrl', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.WORKER_LOCALHOST_AGENT;
    delete process.env.WORKER_LOCALHOST_AGENT;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.WORKER_LOCALHOST_AGENT;
    } else {
      process.env.WORKER_LOCALHOST_AGENT = savedEnv;
    }
  });

  it('returns url unchanged when WORKER_LOCALHOST_AGENT is not set', async () => {
    const { resolveAgentUrl } = await import('../collector-factory');
    expect(resolveAgentUrl('http://192.168.1.50:9090')).toBe('http://192.168.1.50:9090');
    expect(resolveAgentUrl('http://localhost:9090')).toBe('http://localhost:9090');
  });

  it('replaces localhost with docker host', async () => {
    process.env.WORKER_LOCALHOST_AGENT = 'hlm-agent';
    const { resolveAgentUrl } = await import('../collector-factory');
    expect(resolveAgentUrl('http://localhost:9090')).toBe('http://hlm-agent:9090');
    expect(resolveAgentUrl('http://127.0.0.1:9090')).toBe('http://hlm-agent:9090');
    expect(resolveAgentUrl('http://192.168.1.50:9090')).toBe('http://192.168.1.50:9090');
  });
});
