import type { Pool } from 'pg';

export interface ImageUpdateCheckRow {
  host: string;
  image: string;
  currentTag: string | null;
  latestMatchingTag: string | null;
  latestOverallTag: string | null;
  updateAvailable: boolean | null;
  sourceRepo: string | null;
  error: string | null;
  lastErrorAt: Date | null;
  etag: string | null;
  checkedAt: Date;
}

export interface ImageUpdateCheckSuccess {
  host: string;
  image: string;
  currentTag: string | null;
  latestMatchingTag: string | null;
  latestOverallTag: string | null;
  updateAvailable: boolean | null;
  sourceRepo: string | null;
  etag: string | null;
  checkedAt: Date;
}

const COLUMNS = 'host, image, current_tag, latest_matching_tag, latest_overall_tag, update_available, source_repo, error, last_error_at, etag, checked_at';

function rowToCheck(row: Record<string, unknown>): ImageUpdateCheckRow {
  return {
    host: row.host as string,
    image: row.image as string,
    currentTag: (row.current_tag as string | null) ?? null,
    latestMatchingTag: (row.latest_matching_tag as string | null) ?? null,
    latestOverallTag: (row.latest_overall_tag as string | null) ?? null,
    updateAvailable: (row.update_available as boolean | null) ?? null,
    sourceRepo: (row.source_repo as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    lastErrorAt: (row.last_error_at as Date | null) ?? null,
    etag: (row.etag as string | null) ?? null,
    checkedAt: row.checked_at as Date,
  };
}

export class ImageUpdateCheckRepository {
  constructor(private readonly pool: Pool) {}

  async getAll(): Promise<ImageUpdateCheckRow[]> {
    const { rows } = await this.pool.query('SELECT ' + COLUMNS + ' FROM image_update_checks');
    return rows.map(rowToCheck);
  }

  async getByHost(host: string): Promise<ImageUpdateCheckRow[]> {
    const { rows } = await this.pool.query(
      'SELECT ' + COLUMNS + ' FROM image_update_checks WHERE host = $1',
      [host],
    );
    return rows.map(rowToCheck);
  }

  /** Writes the full check result and clears the error columns. Keeps last_error_at as history. */
  async upsertSuccess(check: ImageUpdateCheckSuccess): Promise<void> {
    await this.pool.query(
      `INSERT INTO image_update_checks
         (host, image, current_tag, latest_matching_tag, latest_overall_tag, update_available, source_repo, error, last_error_at, etag, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $9)
       ON CONFLICT (host, image) DO UPDATE SET
         current_tag = EXCLUDED.current_tag,
         latest_matching_tag = EXCLUDED.latest_matching_tag,
         latest_overall_tag = EXCLUDED.latest_overall_tag,
         update_available = EXCLUDED.update_available,
         source_repo = EXCLUDED.source_repo,
         error = NULL,
         etag = EXCLUDED.etag,
         checked_at = EXCLUDED.checked_at`,
      [
        check.host,
        check.image,
        check.currentTag,
        check.latestMatchingTag,
        check.latestOverallTag,
        check.updateAvailable,
        check.sourceRepo,
        check.etag,
        check.checkedAt,
      ],
    );
  }

  /** Records the failure without touching tag columns or checked_at, so the last good data stays readable and ages out normally. */
  async upsertFailure(host: string, image: string, error: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO image_update_checks
         (host, image, current_tag, latest_matching_tag, latest_overall_tag, update_available, source_repo, error, last_error_at, etag, checked_at)
       VALUES ($1, $2, NULL, NULL, NULL, NULL, NULL, $3, $4, NULL, $4)
       ON CONFLICT (host, image) DO UPDATE SET
         error = EXCLUDED.error,
         last_error_at = EXCLUDED.last_error_at`,
      [host, image, error, at],
    );
  }

  /** Deletes rows for (host, image) pairs no longer present in the inventory snapshot. */
  async deleteMissing(keep: Array<{ host: string; image: string }>): Promise<void> {
    const hosts = keep.map((entry) => entry.host);
    const images = keep.map((entry) => entry.image);
    await this.pool.query(
      `DELETE FROM image_update_checks
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest($1::text[], $2::text[]) AS k(h, i)
         WHERE k.h = host AND k.i = image
       )`,
      [hosts, images],
    );
  }

  /** True when the table has no rows or every row is older than the cutoff. */
  async isRefreshDue(olderThan: Date): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT NOT EXISTS (SELECT 1 FROM image_update_checks WHERE checked_at >= $1) AS due',
      [olderThan],
    );
    return rows[0].due as boolean;
  }
}
