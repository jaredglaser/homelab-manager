import type { ReactNode } from 'react';

interface PageStatusBarProps {
  left?: ReactNode;
  right?: ReactNode;
}

export default function PageStatusBar({ left, right }: Readonly<PageStatusBarProps>) {
  if (!left && !right) return null;

  return (
    <div className="py-2 px-4 flex items-center justify-between flex-shrink-0 border-b border-[var(--mui-palette-divider)]/30">
      <div className="flex items-center gap-3 text-sm text-[var(--mui-palette-text-secondary)]">
        {left}
      </div>
      <div className="flex items-center gap-3">
        {right}
      </div>
    </div>
  );
}
