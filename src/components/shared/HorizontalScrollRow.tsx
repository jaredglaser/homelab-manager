import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface HorizontalScrollRowProps {
  children: ReactNode;
  /** CSS variable name (e.g. `--card`) used for the edge fade gradient color. */
  bgVar: string;
  /** Class applied to the inner content row. Use to control gap/min-width/alignment. */
  innerClassName?: string;
  /** Class applied to the scroll container. Use to control padding around the row. */
  scrollClassName?: string;
}

export default memo(function HorizontalScrollRow({
  children,
  bgVar,
  innerClassName = 'flex flex-nowrap gap-1',
  scrollClassName = 'flex flex-nowrap px-2 py-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
}: HorizontalScrollRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el) return;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    // Observe inner content so width changes from late-loading children trigger a re-check
    // without requiring a scroll event.
    if (inner) ro.observe(inner);
    return () => {
      el.removeEventListener('scroll', sync);
      ro.disconnect();
    };
  }, [sync]);

  const nudge = useCallback((dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' });
  }, []);

  const btnClass =
    'flex items-center justify-center shrink-0 w-5 self-stretch text-(--muted-foreground) hover:text-foreground transition-colors cursor-pointer';

  return (
    <div className="relative flex items-center">
      {canScrollLeft && (
        <button type="button" aria-label="Scroll left" onClick={() => nudge('left')} className={`${btnClass} pl-1`}>
          <ChevronLeft size={13} />
        </button>
      )}

      <div className="relative flex-1 min-w-0">
        {canScrollLeft && (
          <div
            className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10"
            style={{ background: `linear-gradient(to right, var(${bgVar}), transparent)` }}
          />
        )}
        <div ref={scrollRef} className={scrollClassName}>
          <div ref={innerRef} className={innerClassName}>
            {children}
          </div>
        </div>
        {canScrollRight && (
          <div
            className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10"
            style={{ background: `linear-gradient(to left, var(${bgVar}), transparent)` }}
          />
        )}
      </div>

      {canScrollRight && (
        <button type="button" aria-label="Scroll right" onClick={() => nudge('right')} className={`${btnClass} pr-1`}>
          <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
});
