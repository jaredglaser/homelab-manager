export type Nullability = boolean | '?';

export interface AttributeCatalog {
  relation: (oid: number) => { name: string; kind: string } | undefined;
  attributeNotNull: (oid: number, attnum: number) => boolean | undefined;
  columnsOf: (table: string) => string[];
  columnNotNull: (table: string, column: string) => boolean | undefined;
}

// A view or continuous aggregate reports every column nullable, which says nothing about the rows it serves.
const ORDINARY_TABLE_KINDS = new Set(['r', 'p']);

export function outerJoinedTables(sql: string): { everything: boolean; tables: Set<string> } {
  const tables = new Set<string>();
  for (const match of sql.matchAll(/\bLEFT\s+(?:OUTER\s+)?JOIN\s+([a-z0-9_]+)/gi)) tables.add(match[1].toLowerCase());
  return { everything: /\b(?:RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\b/i.test(sql), tables };
}

export function selectNullability(column: { tableID: number; columnID: number }, sql: string, catalog: AttributeCatalog): Nullability {
  if (!column.tableID) return '?';
  const relation = catalog.relation(column.tableID);
  if (!relation || !ORDINARY_TABLE_KINDS.has(relation.kind)) return '?';
  const outer = outerJoinedTables(sql);
  if (outer.everything || outer.tables.has(relation.name)) return '?';
  const notNull = catalog.attributeNotNull(column.tableID, column.columnID);
  return notNull === undefined ? '?' : !notNull;
}

export function returningNullability(item: { name: string; plain: boolean }, table: string | undefined, catalog: AttributeCatalog): Nullability {
  if (!item.plain || !table) return '?';
  const notNull = catalog.columnNotNull(table, item.name);
  return notNull === undefined ? '?' : !notNull;
}
