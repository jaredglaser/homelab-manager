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
      <span ref={ref} onMouseEnter={show} onMouseLeave={hide} style={{ display: 'inline-flex' }}>
        {children}
      </span>
      {pos !== null && createPortal(
        <div
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            transform: 'translate(-50%, calc(-100% - 6px))',
            zIndex: 9999,
            pointerEvents: 'none',
            background: 'rgba(97, 97, 97, 0.92)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
          }}
          role="tooltip"
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  );
}
