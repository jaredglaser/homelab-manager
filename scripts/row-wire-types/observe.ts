import type { QuerySite } from './scrape';
import type { ObservedField, ObservedRowType } from './compare';
import type { Nullability } from './nullability';

export function observe(
  observations: Map<string, ObservedRowType>,
  site: QuerySite,
  columns: { name: string; wire: string; nullable: Nullability }[],
): void {
  const key = `${site.file}|${site.rowType}`;
  const observed = observations.get(key) ?? { rowType: site.rowType, file: site.file, line: site.line, rowFields: site.rowFields, fields: new Map(), projections: [] };
  observations.set(key, observed);
  observed.rowFields ??= site.rowFields;
  for (const column of columns) {
    const slot: ObservedField = observed.fields.get(column.name) ?? { wire: new Set<string>(), nullable: '?' as const, seen: 0 };
    slot.wire.add(column.wire);
    slot.seen += 1;
    if (column.nullable !== '?') slot.nullable = slot.nullable === '?' || slot.nullable === column.nullable ? column.nullable : 'mixed';
    observed.fields.set(column.name, slot);
  }
}
