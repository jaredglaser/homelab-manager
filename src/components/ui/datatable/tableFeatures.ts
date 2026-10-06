import {
  tableFeatures,
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSortingFeature,
  rowExpandingFeature,
  createSortedRowModel,
  createExpandedRowModel,
} from '@tanstack/react-table';

/**
 * Shared TanStack Table v9 feature set for every DataTable in the app.
 *
 * Features gate which APIs exist (and which code is bundled): only the
 * capabilities the app's tables actually use are registered —
 * column visibility (mobile metric groups), sizing/resizing (grid layout),
 * sorting (zfs/proxmox), and expanding (docker/zfs tree data + detail
 * panels). Filtering, pagination, grouping, pinning, selection, and
 * aggregation are intentionally absent; DataTable's `enableFiltering` prop
 * was dead — no caller ever enabled it.
 *
 * Row model factories live on the features object in v9 (not as table
 * options), which is what enables the tree-shaking.
 */
export const dataTableFeatures = tableFeatures({
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSortingFeature,
  rowExpandingFeature,
  sortedRowModel: createSortedRowModel(),
  expandedRowModel: createExpandedRowModel(),
});

export type DataTableFeatures = typeof dataTableFeatures;
