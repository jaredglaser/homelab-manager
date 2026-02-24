/** CSS Grid column template for the guest (VM/container) table */
export const GUEST_GRID =
  'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] min-w-[800px]'

/** CSS Grid column template for the storage table */
export const STORAGE_GRID =
  'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2fr)] min-w-[800px]'

/** Top border separator between rows */
export const BORDER = 'border-t border-neutral-200 dark:border-neutral-700'

/** Row hover highlight matching the project-wide table hover style */
export const ROW_HOVER =
  'hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)] transition-[background-color,box-shadow] duration-150'
