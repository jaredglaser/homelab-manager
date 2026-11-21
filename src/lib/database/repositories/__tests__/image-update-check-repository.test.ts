import { describe, expect, it, beforeEach } from 'bun:test';
import { ImageUpdateCheckRepository } from '../image-update-check-repository';
import { createMockPool } from '@/lib/test/mock-pool';

const baseRow = {
  host: 'host1',
  stack: 'web',
  image: 'redis:7',
  current_tag: '7',
  latest_matching_tag: '7.4.1',
  latest_overall_tag: '8.0.0',
  update_available: true,
  source_repo: 'o/r',
  error: null,
  last_error_at: new Date('2026-01-01T00:00:00Z'),
  etag: '"sha256:' + 'a'.repeat(64) + '"',
  manifest_digest: 'sha256:' + 'c'.repeat(64),
  checked_at: new Date('2026-01-02T00:00:00Z'),
};

describe('ImageUpdateCheckRepository', () => {
  let repo: ImageUpdateCheckRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new ImageUpdateCheckRepository(mock.pool);
  });

  it('getAll selects every row and maps snake_case to the row type', async () => {
    mock.pushResult([baseRow]);
    const rows = await repo.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      host: 'host1',
      stack: 'web',
      image: 'redis:7',
      currentTag: '7',
      latestMatchingTag: '7.4.1',
      latestOverallTag: '8.0.0',
      updateAvailable: true,
      sourceRepo: 'o/r',
      error: null,
      lastErrorAt: new Date('2026-01-01T00:00:00Z'),
      etag: '"sha256:' + 'a'.repeat(64) + '"',
      manifestDigest: 'sha256:' + 'c'.repeat(64),
      checkedAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(mock.queries[0].sql).toContain('FROM image_update_checks');
    expect(mock.queries[0].sql).not.toContain('WHERE');
  });

  it('getByStack filters by host and stack', async () => {
    mock.pushResult([baseRow]);
    const rows = await repo.getByStack('host1', 'web');
    expect(rows).toHaveLength(1);
    expect(mock.queries[0].params).toEqual(['host1', 'web']);
  });

  it('upsertSuccess inserts the full row with cleared error columns', async () => {
    await repo.upsertSuccess({
      host: 'host1',
      stack: 'web',
      image: 'redis:7',
      currentTag: '7',
      latestMatchingTag: '7.4.2',
      latestOverallTag: '8.0.0',
      updateAvailable: true,
      sourceRepo: 'o/r',
      etag: '"sha256:' + 'b'.repeat(64) + '"',
      manifestDigest: 'sha256:' + 'd'.repeat(64),
      checkedAt: new Date('2026-01-03T00:00:00Z'),
    });
    const { sql, params } = mock.queries[0];
    expect(sql).toContain('INSERT INTO image_update_checks');
    expect(sql).toContain('ON CONFLICT (host, stack, image) DO UPDATE');
    expect(sql).toContain('error = NULL');
    expect(sql).toContain('manifest_digest = EXCLUDED.manifest_digest');
    expect(sql).not.toContain('last_error_at = EXCLUDED');
    expect(params[0]).toBe('host1');
    expect(params[1]).toBe('web');
    expect(params[8]).toBe('"sha256:' + 'b'.repeat(64) + '"');
    expect(params[9]).toBe('sha256:' + 'd'.repeat(64));
    expect(params[10]).toEqual(new Date('2026-01-03T00:00:00Z'));
  });

  it('upsertFailure inserts error-only rows and updates only error columns on conflict', async () => {
    await repo.upsertFailure('host1', 'web', 'redis:7', 'Docker Hub returned 503', new Date('2026-01-04T00:00:00Z'));
    const { sql, params } = mock.queries[0];
    expect(sql).toContain('INSERT INTO image_update_checks');
    expect(sql).toContain('ON CONFLICT (host, stack, image) DO UPDATE');
    expect(sql).toContain('error = EXCLUDED.error');
    expect(sql).toContain('last_error_at = EXCLUDED.last_error_at');
    expect(sql).not.toContain('current_tag = EXCLUDED');
    expect(params[0]).toBe('host1');
    expect(params[1]).toBe('web');
    expect(params[3]).toBe('Docker Hub returned 503');
    expect(params[4]).toEqual(new Date('2026-01-04T00:00:00Z'));
  });

  it('deleteMissing removes rows whose (host, stack, image) triple is absent from the snapshot', async () => {
    await repo.deleteMissing([
      { host: 'host1', stack: 'web', image: 'redis:7' },
      { host: 'host2', stack: 'api', image: 'traefik:v3.1' },
    ]);
    const { sql, params } = mock.queries[0];
    expect(sql).toContain('DELETE FROM image_update_checks');
    expect(sql).toContain('NOT EXISTS');
    expect(params[0]).toEqual(['host1', 'host2']);
    expect(params[1]).toEqual(['web', 'api']);
    expect(params[2]).toEqual(['redis:7', 'traefik:v3.1']);
  });

  it('deleteMissing with an empty keep list deletes everything', async () => {
    await repo.deleteMissing([]);
    const { params } = mock.queries[0];
    expect(params[0]).toEqual([]);
    expect(params[1]).toEqual([]);
    expect(params[2]).toEqual([]);
  });

  it('isRefreshDue reports due when no row is newer than the cutoff', async () => {
    mock.pushResult([{ due: true }]);
    expect(await repo.isRefreshDue(new Date('2026-01-01T00:00:00Z'))).toBe(true);
    mock.pushResult([{ due: false }]);
    expect(await repo.isRefreshDue(new Date('2026-01-01T00:00:00Z'))).toBe(false);
    expect(mock.queries[0].sql).toContain('NOT EXISTS');
  });
});
