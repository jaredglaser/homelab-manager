import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsTouch } from '@/hooks/useMediaQuery';

interface TapTooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

const DEFAULT_CONTENT_CLASSES =
  'rounded-lg px-2 py-1 text-[0.6875rem] font-medium text-tooltip-foreground bg-tooltip/92 max-w-75 break-words';

/**
 * Tooltip that also reveals on tap. Base UI's Tooltip only opens for mouse/pen
 * pointer types (`useHoverReferenceInteraction`'s `mouseOnly: true`), so content
 * that lives only in a tooltip is unreachable on touch without this. Positions
 * via getBoundingClientRect into a body portal, because a Popper-style tooltip
 * is misplaced inside DataTable rows and Dialog headers by their nested scroll
 * container and transform contexts.
 */
export default function TapTooltip({ content, children, className, contentClassName }: Readonly<TapTooltipProps>) {
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
        className={className ?? 'inline-flex'}
      >
        {children}
      </span>
      {pos !== null && createPortal(
        <div
          className={`fixed z-[9999] pointer-events-none -translate-x-1/2 -translate-y-[calc(100%+6px)] ${contentClassName ?? DEFAULT_CONTENT_CLASSES}`}
          style={{ left: pos.x, top: pos.y }}
          role="tooltip"
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
