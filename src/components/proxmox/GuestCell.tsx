import { memo } from 'react';

interface GuestCellProps {
  vmid: number;
  name: string;
}

export const GuestCell = memo(function GuestCell({ vmid, name }: GuestCellProps) {
  return (
    <div className="flex items-center gap-2 truncate">
      <span className="text-(--mui-palette-text-secondary) tabular-nums">{vmid}</span>
      <span className="truncate">{name}</span>
    </div>
  );
});
