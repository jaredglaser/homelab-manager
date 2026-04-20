export interface RowAccessors<
  TRow,
  TKey extends PropertyKey = string,
  TEntity extends PropertyKey = string,
> {
  key: (row: TRow) => TKey;
  time: (row: TRow) => number;
  entity: (row: TRow) => TEntity;
}
