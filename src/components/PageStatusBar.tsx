import type { ReactNode } from 'react';

interface PageStatusBarProps {
  left?: ReactNode;
  right?: ReactNode;
}

export default function PageStatusBar({ left, right }: Readonly<PageStatusBarProps>) {
  if (!left && !right) return null;

  return (
    <div className="py-2 px-4 flex items-center justify-between shrink-0 border-b border-(--mui-palette-divider)/30">
      <div className="flex items-center gap-3 text-sm text-(--mui-palette-text-secondary)">
        {left}
      </div>
      <div className="flex items-center gap-3">
        {right}
      </div>
    </div>
  );
}
