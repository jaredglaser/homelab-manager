export interface QueryCall {
  sql: string;
  params: unknown[];
}

export function createMockPool(defaultRows: Record<string, unknown>[] = []) {
  const queries: QueryCall[] = [];
  const queuedResults: Record<string, unknown>[][] = [];

  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        const result = queuedResults.length > 0 ? queuedResults.shift()! : defaultRows;
        return { rows: result };
      },
    } as any,
    queries,
    pushResult(r: Record<string, unknown>[]) {
      queuedResults.push(r);
    },
  };
}
