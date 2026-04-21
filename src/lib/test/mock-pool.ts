export interface QueryCall {
  sql: string;
  params: unknown[];
}

export function createMockPool(defaultRows: Record<string, unknown>[] = []) {
  const queries: QueryCall[] = [];
  const queuedResults: Record<string, unknown>[][] = [];
  let defaultResult: Record<string, unknown>[] = defaultRows;
  let shouldThrow: Error | null = null;

  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        if (shouldThrow) throw shouldThrow;
        queries.push({ sql, params: params ?? [] });
        const result = queuedResults.length > 0 ? queuedResults.shift()! : defaultResult;
        return { rows: result, rowCount: result.length };
      },
    } as any,
    queries,
    pushResult(r: Record<string, unknown>[]) {
      queuedResults.push(r);
    },
    setDefault(r: Record<string, unknown>[]) {
      defaultResult = r;
    },
    setError(err: Error) {
      shouldThrow = err;
    },
    clearError() {
      shouldThrow = null;
    },
  };
}
