import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface IconTooltipProps {
  label: string;
  children: React.ReactNode;
}

/**
 * Tooltip for icon-only buttons that computes position via getBoundingClientRect on
 * mouseenter and portals into document.body. MUI Tooltip (Popper.js) misplaces tooltips
 * inside DataTable rows and Dialog headers due to nested scroll container / transform context.
 */
export default function IconTooltip({ label, children }: IconTooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  return (
    <>
      <span ref={ref} onMouseEnter={show} onMouseLeave={hide} className="inline-flex">
        {children}
      </span>
      {pos !== null && createPortal(
        <div
          className="fixed z-[9999] pointer-events-none -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded px-2 py-1 text-xs leading-[1.4] whitespace-nowrap text-white bg-(--mui-palette-grey-700)/90"
          style={{ left: pos.x, top: pos.y }}
          role="tooltip"
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  );
}
