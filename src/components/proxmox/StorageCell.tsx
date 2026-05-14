import { memo } from 'react';

interface StorageCellProps {
  name: string;
  type: string;
}

export const StorageCell = memo(function StorageCell({ name, type }: StorageCellProps) {
  return (
    <div className="flex items-center gap-2 truncate">
      <span className="truncate">{name}</span>
      <span className="text-xs text-(--mui-palette-text-secondary)">({type})</span>
    </div>
  );
});
