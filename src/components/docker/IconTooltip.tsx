import type { ReactNode } from 'react';
import TapTooltip from '@/components/ui/tap-tooltip';

interface IconTooltipProps {
  label: string;
  children: ReactNode;
}

/** Single-line label for an icon-only button. */
export default function IconTooltip({ label, children }: Readonly<IconTooltipProps>) {
  return (
    <TapTooltip
      content={label}
      contentClassName="rounded px-2 py-1 text-xs leading-[1.4] whitespace-nowrap text-white bg-(--tooltip)/90"
    >
      {children}
    </TapTooltip>
  );
}
