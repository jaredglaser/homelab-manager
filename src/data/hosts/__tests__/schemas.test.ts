import { describe, it, expect } from 'bun:test';
import { addHostSchema, removeHostSchema, updateAgentSchema, checkHostHealthSchema } from '../schemas';

describe('addHostSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = addHostSchema.parse({
      name: 'my-server',
      socketProxyUrl: 'tcp://192.168.1.10:2375',
      agentPort: 8080,
    });
    expect(result).toEqual({ name: 'my-server', socketProxyUrl: 'tcp://192.168.1.10:2375', agentPort: 8080 });
  });

  it('defaults agentPort to 9090', () => {
    expect(addHostSchema.parse({ name: 'x', socketProxyUrl: 'tcp://x:1' }).agentPort).toBe(9090);
  });

  it('rejects empty name', () => {
    expect(() => addHostSchema.parse({ name: '', socketProxyUrl: 'tcp://x:1' })).toThrow();
  });

  it('rejects name with special characters', () => {
    expect(() => addHostSchema.parse({ name: 'server.local', socketProxyUrl: 'tcp://x:1' })).toThrow();
    expect(() => addHostSchema.parse({ name: 'my server', socketProxyUrl: 'tcp://x:1' })).toThrow();
  });

  it('accepts name with hyphens and underscores', () => {
    expect(addHostSchema.parse({ name: 'my-server_01', socketProxyUrl: 'tcp://x:1' }).name).toBe('my-server_01');
  });

  it('rejects name over 100 chars', () => {
    expect(() => addHostSchema.parse({ name: 'a'.repeat(101), socketProxyUrl: 'tcp://x:1' })).toThrow();
  });

  it('accepts tcp://, http://, https:// schemes', () => {
    for (const scheme of ['tcp', 'http', 'https']) {
      expect(() => addHostSchema.parse({ name: 'x', socketProxyUrl: `${scheme}://host:1` })).not.toThrow();
    }
  });

  it('rejects invalid schemes', () => {
    for (const url of ['ftp://x:1', 'unix:///sock', 'x:1', 'tcp://']) {
      expect(() => addHostSchema.parse({ name: 'x', socketProxyUrl: url })).toThrow();
    }
  });

  it('rejects agentPort out of range', () => {
    expect(() => addHostSchema.parse({ name: 'x', socketProxyUrl: 'tcp://x:1', agentPort: 0 })).toThrow();
    expect(() => addHostSchema.parse({ name: 'x', socketProxyUrl: 'tcp://x:1', agentPort: 65536 })).toThrow();
    expect(() => addHostSchema.parse({ name: 'x', socketProxyUrl: 'tcp://x:1', agentPort: 1.5 })).toThrow();
  });

  it('accepts boundary ports', () => {
    expect(addHostSchema.parse({ name: 'x', socketProxyUrl: 'tcp://x:1', agentPort: 1 }).agentPort).toBe(1);
    expect(addHostSchema.parse({ name: 'x', socketProxyUrl: 'tcp://x:1', agentPort: 65535 }).agentPort).toBe(65535);
  });
});

describe('removeHostSchema', () => {
  it('accepts positive integer', () => {
    expect(removeHostSchema.parse({ hostId: 1 }).hostId).toBe(1);
  });

  it('rejects zero, negative, non-integer', () => {
    expect(() => removeHostSchema.parse({ hostId: 0 })).toThrow();
    expect(() => removeHostSchema.parse({ hostId: -1 })).toThrow();
    expect(() => removeHostSchema.parse({ hostId: 1.5 })).toThrow();
  });
});

describe('updateAgentSchema', () => {
  it('accepts positive integer', () => {
    expect(updateAgentSchema.parse({ hostId: 42 }).hostId).toBe(42);
  });

  it('rejects invalid values', () => {
    expect(() => updateAgentSchema.parse({ hostId: 0 })).toThrow();
    expect(() => updateAgentSchema.parse({})).toThrow();
  });
});

describe('checkHostHealthSchema', () => {
  it('accepts positive integer', () => {
    expect(checkHostHealthSchema.parse({ hostId: 7 }).hostId).toBe(7);
  });

  it('rejects invalid values', () => {
    expect(() => checkHostHealthSchema.parse({ hostId: 0 })).toThrow();
    expect(() => checkHostHealthSchema.parse({ hostId: -1 })).toThrow();
  });
});
