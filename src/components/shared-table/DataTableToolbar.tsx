import type { ReactNode } from 'react';
import { ToggleButtonGroup, ToggleButton } from '@mui/material';
import type { MetricGroup } from '@/components/shared-table/DataTable';

interface DataTableToolbarProps {
  metricGroups?: MetricGroup[];
  activeGroupIndex: number;
  onGroupChange: (index: number) => void;
  isMobile: boolean;
  /** Optional toolbar actions rendered alongside metric toggles */
  children?: ReactNode;
}

/**
 * Toolbar rendered above the DataTable. On mobile, shows metric group toggle
 * buttons so only one group of columns is visible at a time. Also renders
 * any additional toolbar actions passed as children.
 */
export function DataTableToolbar({
  metricGroups,
  activeGroupIndex,
  onGroupChange,
  isMobile,
  children,
}: Readonly<DataTableToolbarProps>) {
  const showToggles = isMobile && metricGroups != null && metricGroups.length > 0;

  if (!showToggles && !children) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 flex-wrap">
      {showToggles && (
        <ToggleButtonGroup
          value={activeGroupIndex}
          exclusive
          size="small"
          onChange={(_, value: number | null) => {
            if (value !== null) {
              onGroupChange(value);
            }
          }}
          aria-label="metric group"
        >
          {metricGroups!.map((group, index) => (
            <ToggleButton key={group.label} value={index} aria-label={group.label}>
              {group.icon && <span className="mr-1 flex items-center">{group.icon}</span>}
              {group.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
      {children}
    </div>
  );
}
