import { describe, it, expect } from 'bun:test';
import { parseSettings } from '@/hooks/settingsAtom';

describe('parseSettings: containerShells', () => {
  it('defaults containerShells to empty object when key absent', () => {
    const settings = parseSettings({});
    expect(settings.docker.containerShells).toEqual({});
  });

  it('parses a valid containerShells JSON map', () => {
    const settings = parseSettings({
      'docker/containerShells': JSON.stringify({ 'server1/nginx': 'bash', 'server1/redis': 'sh' }),
    });
    expect(settings.docker.containerShells).toEqual({ 'server1/nginx': 'bash', 'server1/redis': 'sh' });
  });

  it('falls back to empty object on invalid JSON', () => {
    const settings = parseSettings({ 'docker/containerShells': '{not-json}' });
    expect(settings.docker.containerShells).toEqual({});
  });
});
