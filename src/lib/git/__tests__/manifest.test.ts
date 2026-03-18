import { describe, it, expect } from 'bun:test';
import { parseManifest } from '../manifest';

describe('parseManifest', () => {
  it('should parse a valid manifest YAML string', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
    auto_deploy: true
  traefik:
    host: homeserver
    auto_deploy: false
`;
    const result = parseManifest(yaml);
    expect(result.stacks.plex).toEqual({ host: 'homeserver', auto_deploy: true });
    expect(result.stacks.traefik).toEqual({ host: 'homeserver', auto_deploy: false });
  });

  it('should reject manifest with missing host', () => {
    const yaml = `
stacks:
  plex:
    auto_deploy: true
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should reject manifest with missing stacks key', () => {
    const yaml = `
something_else:
  plex:
    host: homeserver
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should default auto_deploy to false when omitted', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
`;
    const result = parseManifest(yaml);
    expect(result.stacks.plex.auto_deploy).toBe(false);
  });

  it('should reject invalid YAML', () => {
    const yaml = `{{{not yaml`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should parse manifest with multiple stacks on different hosts', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
    auto_deploy: true
  pihole:
    host: pihole-host
    auto_deploy: true
`;
    const result = parseManifest(yaml);
    expect(Object.keys(result.stacks)).toHaveLength(2);
    expect(result.stacks.pihole.host).toBe('pihole-host');
  });

  it('should reject unknown keys in stack entries (catches typos)', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
    autoDeploy: true
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should reject unknown keys at manifest level', () => {
    const yaml = `
stacks:
  plex:
    host: homeserver
extra_field: true
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('should reject stacks with empty host string', () => {
    const yaml = `
stacks:
  plex:
    host: ""
    auto_deploy: true
`;
    expect(() => parseManifest(yaml)).toThrow();
  });
});
