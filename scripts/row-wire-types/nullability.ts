export type Nullability = boolean | '?';

export interface AttributeCatalog {
  relation: (oid: number) => { name: string; kind: string } | undefined;
  attributeNotNull: (oid: number, attnum: number) => boolean | undefined;
  columnsOf: (table: string) => string[];
  columnNotNull: (table: string, column: string) => boolean | undefined;
}

// A view or continuous aggregate reports every column nullable, which says nothing about the rows it serves.
const ORDINARY_TABLE_KINDS = new Set(['r', 'p']);

export interface OuterJoins {
  /** A join this script cannot attribute to one table (RIGHT or FULL, a subquery, LATERAL, a schema-qualified or quoted name), so no column can be trusted. */
  everything: boolean;
  /** The plain table names on the nullable side of a LEFT JOIN. */
  tables: Set<string>;
}

export function outerJoinedTables(sql: string): OuterJoins {
  const tables = new Set<string>();
  let everything = false;
  for (const match of sql.matchAll(/\b(LEFT|RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\s+(\(|[^\s(]+)/gi)) {
    const side = match[1].toUpperCase();
    const target = match[2];
    if (side !== 'LEFT' || target === '(' || /^lateral$/i.test(target) || /[."]/.test(target)) {
      everything = true;
    } else {
      tables.add(target.toLowerCase());
    }
  }
  return { everything, tables };
}

function occurrences(sql: string, table: string): number {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z0-9_"]+)/gi)].filter((match) => match[1].toLowerCase() === table).length;
}

export function selectNullability(column: { tableID: number; columnID: number }, sql: string, catalog: AttributeCatalog): Nullability {
  if (!column.tableID) return '?';
  const relation = catalog.relation(column.tableID);
  if (!relation || !ORDINARY_TABLE_KINDS.has(relation.kind)) return '?';
  const outer = outerJoinedTables(sql);
  if (outer.everything) return '?';
  // A joined name that is not a table (a CTE) hides which side the column came from.
  if ([...outer.tables].some((table) => catalog.columnsOf(table).length === 0)) return '?';
  if (outer.tables.has(relation.name)) {
    // The same table on both sides of the join cannot be told apart by tableID.
    return occurrences(sql, relation.name) > 1 ? '?' : true;
  }
  const notNull = catalog.attributeNotNull(column.tableID, column.columnID);
  return notNull === undefined ? '?' : !notNull;
}

export function returningNullability(item: { name: string; plain: boolean }, table: string | undefined, catalog: AttributeCatalog): Nullability {
  if (!item.plain || !table) return '?';
  const notNull = catalog.columnNotNull(table, item.name);
  return notNull === undefined ? '?' : !notNull;
}
