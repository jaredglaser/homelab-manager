import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useIsTouch } from '@/hooks/useMediaQuery';

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
  const isTouch = useIsTouch();

  const show = useCallback(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  const toggle = useCallback(() => {
    if (!isTouch) return;
    setPos((current) => {
      if (current !== null) return null;
      if (!ref.current) return current;
      const r = ref.current.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top };
    });
  }, [isTouch]);

  useEffect(() => {
    if (!isTouch || pos === null) return;
    // pointerdown fires before the tap's own click that reopens/toggles here, so an
    // outside tap can dismiss without racing this element's own toggle.
    function dismissIfOutside(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) hide();
    }
    document.addEventListener('pointerdown', dismissIfOutside);
    return () => document.removeEventListener('pointerdown', dismissIfOutside);
  }, [isTouch, pos, hide]);

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={() => {
          if (!isTouch) show();
        }}
        onMouseLeave={() => {
          if (!isTouch) hide();
        }}
        onFocus={() => {
          if (!isTouch) show();
        }}
        onBlur={() => {
          if (!isTouch) hide();
        }}
        onClick={toggle}
        className="inline-flex"
      >
        {children}
      </span>
      {pos !== null && createPortal(
        <div
          className="fixed z-[9999] pointer-events-none -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded px-2 py-1 text-xs leading-[1.4] whitespace-nowrap text-white bg-(--tooltip)/90"
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
