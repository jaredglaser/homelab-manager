import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Checks } from './checks';

export const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction';

/**
 * A migration carrying `-- migrate:no-transaction` must have every statement
 * individually idempotent. It has no rollback, so a mid-file failure leaves
 * partial state and the runner re-runs the whole file on the next boot; a
 * statement that cannot tolerate already having been applied turns a transient
 * failure into one that repeats on every subsequent boot. Transactional
 * migrations carry no such requirement.
 */
export function noTransactionMigrations(root: string): string[] {
  const dir = join(root, 'migrations');
  return readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .filter(file => carriesDirective(readFileSync(join(dir, file), 'utf-8')));
}

function carriesDirective(sql: string): boolean {
  return sql
    .split('\n')
    .some(line => line.trim().toLowerCase().startsWith(NO_TRANSACTION_DIRECTIVE));
}

/**
 * The ledger-based idempotency scenario cannot reach this: the ledger is what
 * prevents the replay that would expose a non-idempotent statement. Replaying
 * through the runner rather than executing the SQL here keeps whatever
 * statement-splitting and transaction suppression the runner implements inside
 * the path under test.
 */
export async function assertNoTransactionReplay(
  pool: Pool,
  checks: Checks,
  root: string,
  applyMigrations: () => Promise<void>
): Promise<void> {
  const directiveFiles = noTransactionMigrations(root);
  console.info(
    `[replay] no-transaction migrations: ${directiveFiles.join(', ') || 'none'}`
  );

  const before = await ledgerTimestamps(pool);
  const replayed: string[] = [];

  for (const file of directiveFiles) {
    const deleted = await pool.query('DELETE FROM migrations WHERE name = $1', [file]);
    checks.equal(`${file} was removed from the ledger for replay`, deleted.rowCount, 1);

    try {
      await applyMigrations();
      replayed.push(file);
      checks.record(`${file} re-applies cleanly with no rollback available`, true);
    } catch (err) {
      checks.record(
        `${file} re-applies cleanly with no rollback available`,
        false,
        `every statement must be individually idempotent: ${String(err).slice(0, 200)}`
      );
      await pool.query(
        'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [file]
      );
    }
  }

  checks.sameSet('every no-transaction migration on disk was replayed', replayed, directiveFiles);

  const after = await ledgerTimestamps(pool);
  const notReExecuted = replayed.filter(file => before.get(file) === after.get(file));
  checks.sameSet('replayed migrations were genuinely re-executed', notReExecuted, []);
  checks.containsAll('ledger is restored after replay', [...after.keys()], directiveFiles);
}

async function ledgerTimestamps(pool: Pool): Promise<Map<string, string>> {
  const result = await pool.query('SELECT name, executed_at FROM migrations');
  return new Map(
    result.rows.map(row => [row.name as string, new Date(row.executed_at).toISOString()])
  );
}
