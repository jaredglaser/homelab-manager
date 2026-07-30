import type { ReactNode } from 'react';

interface PageStatusBarProps {
  left?: ReactNode;
  right?: ReactNode;
}

export default function PageStatusBar({ left, right }: Readonly<PageStatusBarProps>) {
  if (!left && !right) return null;

  return (
    <div className="py-2 px-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 shrink-0 border-b border-(--border)/30">
      <div className="flex flex-wrap items-center gap-3 text-sm text-(--muted-foreground)">
        {left}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {right}
      </div>
    </div>
  );
}
