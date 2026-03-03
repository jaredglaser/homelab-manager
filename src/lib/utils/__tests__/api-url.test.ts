import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { apiUrl } from '../api-url';

describe('apiUrl', () => {
  let originalBaseUrl: string | undefined;

  beforeEach(() => {
    originalBaseUrl = import.meta.env.BASE_URL;
  });

  afterEach(() => {
    (import.meta.env as Record<string, string>).BASE_URL = originalBaseUrl!;
  });

  it('returns path unchanged when BASE_URL is "/"', () => {
    (import.meta.env as Record<string, string>).BASE_URL = '/';
    expect(apiUrl('/api/docker-stats')).toBe('/api/docker-stats');
  });

  it('prepends sub-path when BASE_URL has a prefix', () => {
    (import.meta.env as Record<string, string>).BASE_URL = '/homelab-manager/';
    expect(apiUrl('/api/docker-stats')).toBe('/homelab-manager/api/docker-stats');
  });

  it('handles query strings correctly', () => {
    (import.meta.env as Record<string, string>).BASE_URL = '/app/';
    expect(apiUrl('/api/docker-logs/abc123?host=server1')).toBe('/app/api/docker-logs/abc123?host=server1');
  });

});
