import { afterAll, describe, expect, test } from 'bun:test';
import { jsonResponse, withFetch } from '@/lib/test/fetch-mock';

process.env.IMAGE_UPDATE_EXTRA_REGISTRIES = 'nas.lan:5000,registry.home.arpa';

const { checkImageUpdate } = await import('../registry-client');

afterAll(() => {
  delete process.env.IMAGE_UPDATE_EXTRA_REGISTRIES;
});

describe('IMAGE_UPDATE_EXTRA_REGISTRIES wiring', () => {
  test('an extra registry is checked through the v2 flow on its own host', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      expect(String(url).startsWith('https://nas.lan:5000/')).toBe(true);
      if (String(url) === 'https://nas.lan:5000/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(jsonResponse({ tags: ['1.0.0', '1.0.5'] }));
    });
    try {
      const summary = await checkImageUpdate('nas.lan:5000/team/app:1.0', {});
      expect(summary.updateAvailable).toBe(true);
      expect(summary.latestMatchingTag).toBe('1.0.5');
      expect(summary.error).toBeNull();
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('a second extra registry resolves the same way', async () => {
    const { restore } = withFetch((url) => {
      expect(String(url).startsWith('https://registry.home.arpa/')).toBe(true);
      if (String(url) === 'https://registry.home.arpa/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(jsonResponse({ tags: ['2.0.0'] }));
    });
    try {
      const summary = await checkImageUpdate('registry.home.arpa/team/app:2.0', {});
      expect(summary.updateAvailable).toBe(false);
      expect(summary.error).toBeNull();
    } finally {
      restore();
    }
  });
});