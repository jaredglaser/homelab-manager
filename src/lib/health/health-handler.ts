const DB_CHECK_TIMEOUT_MS = 5000;

/** Round-trips the connection pool so a wedged database reports as unhealthy, not just a dead TCP target. */
export async function checkDatabase(): Promise<void> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const client = await databaseConnectionManager.getClient(loadDatabaseConfig());
  await client.getPool().query('SELECT 1');
}

/**
 * Liveness/readiness probe for the web container. Unauthenticated by design:
 * Docker healthchecks and uptime monitors must reach it before any login
 * exists, so the body carries no version, config, or entity details.
 *
 * @returns 200 `{status:'ok',database:true}` when the DB answers within the
 * timeout, 503 `{status:'degraded',database:false}` otherwise.
 */
export async function handleHealth(
  check: () => Promise<void> = checkDatabase,
  timeoutMs: number = DB_CHECK_TIMEOUT_MS,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Database health check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return Response.json({ status: 'ok', database: true });
  } catch (err) {
    console.error('[health] Database check failed:', err instanceof Error ? err.message : err);
    return Response.json({ status: 'degraded', database: false }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
