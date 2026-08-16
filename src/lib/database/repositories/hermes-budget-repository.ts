import '@tanstack/react-start/server-only';
import type { Pool } from 'pg';

export type BudgetBucket = 't0' | 't1' | 't2' | 'page';

const EMPTY: Record<BudgetBucket, number> = { t0: 0, t1: 0, t2: 0, page: 0 };

/** Days kept for inspection after their budget stops being consulted. */
export const BUDGET_RETENTION_DAYS = 14;

function isBucket(value: string): value is BudgetBucket {
  return value === 't0' || value === 't1' || value === 't2' || value === 'page';
}

export class HermesBudgetRepository {
  constructor(private readonly pool: Pool) {}

  async load(day: string): Promise<Record<BudgetBucket, number>> {
    const result = await this.pool.query('SELECT bucket, spent FROM hermes_budget WHERE day = $1', [day]);
    const spend = { ...EMPTY };
    for (const row of result.rows as { bucket: string; spent: unknown }[]) {
      if (isBucket(row.bucket)) spend[row.bucket] = Number(row.spent);
    }
    return spend;
  }

  async increment(day: string, bucket: BudgetBucket, by: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO hermes_budget (day, bucket, spent)
       VALUES ($1, $2, $3)
       ON CONFLICT (day, bucket) DO UPDATE SET spent = hermes_budget.spent + EXCLUDED.spent`,
      [day, bucket, by],
    );
  }

  async pruneBefore(day: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM hermes_budget WHERE day < ($1::date - $2::int)`,
      [day, BUDGET_RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
  }
}
