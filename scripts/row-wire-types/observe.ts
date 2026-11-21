import type { QuerySite } from './scrape';
import type { ObservedField, ObservedRowType } from './compare';

/** What `run.ts` knows about the migrated schema: the columns of a table, the tables a statement
 * names, and whether a column is nullable across those tables. */
export interface Catalog {
  columnsOf: (table: string) => string[];
  tablesIn: (sql: string) => string[];
  nullability: (column: string, tables: string[]) => boolean | '?' | 'mixed';
}

/** Records one statement's columns against the row type it feeds. */
export function observe(
  observations: Map<string, ObservedRowType>,
  site: QuerySite,
  columns: { name: string; wire: string }[],
  sql: string,
  catalog: Catalog,
): void {
  const key = `${site.file}|${site.rowType}`;
  if (!observations.has(key)) {
    observations.set(key, { rowType: site.rowType, file: site.file, line: site.line, rowFields: site.rowFields, fields: new Map(), projections: [] });
  }
  const observed = observations.get(key);
  if (!observed) return;
  if (site.rowFields) observed.rowFields = site.rowFields;
  for (const column of columns) {
    const slot: ObservedField = observed.fields.get(column.name) ?? { wire: new Set<string>(), nullable: '?' as const, seen: 0 };
    slot.wire.add(column.wire);
    slot.seen += 1;
    const nullable = catalog.nullability(column.name, catalog.tablesIn(sql));
    if (nullable !== '?') slot.nullable = slot.nullable === '?' || slot.nullable === nullable ? nullable : 'mixed';
    observed.fields.set(column.name, slot);
  }
}