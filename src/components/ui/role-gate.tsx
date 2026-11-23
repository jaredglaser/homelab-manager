import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRoleAccess, type RoleRequirement } from '@/hooks/useAuth';
import { cn } from '@/lib/utils/cn';

interface RoleGateProps {
  requires: RoleRequirement;
  /** Replaces the role's reason, for a control whose denial is about seeing rather than changing. */
  deniedReason?: string;
  /** Layout classes for the wrapper a blocked control gets, so it takes the same space as the bare control. */
  className?: string;
  children: (blocked: boolean) => ReactNode;
}

/**
 * The `Button` `requires` gate for a control that is not a `Button` (switch, slider, select, tab).
 * A blocked control renders disabled inside a focusable wrapper that shows the reason on hover, keyboard focus and tap.
 */
export function RoleGate({ requires, deniedReason, className, children }: RoleGateProps) {
  const access = useRoleAccess(requires);
  const reasonId = useId();
  const [hoverOrFocusOpen, setHoverOrFocusOpen] = useState(false);
  const [tapOpen, setTapOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!tapOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setTapOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress, true);
  }, [tapOpen]);

  if (access.kind === 'allowed') return children(false);
  if (access.kind === 'unknown') return children(true);
  const reason = deniedReason ?? access.reason;

  // The disabled control takes no pointer events, so hover and tap land on the wrapper that carries the reason.
  return (
    <>
      <Tooltip
        open={hoverOrFocusOpen || tapOpen}
        onOpenChange={(next, details) => {
          setHoverOrFocusOpen(next);
          if (!next && details.reason !== 'trigger-press' && details.reason !== 'trigger-hover') setTapOpen(false);
        }}
      >
        <TooltipTrigger
          render={
            <span
              ref={wrapperRef}
              data-slot="role-gate"
              tabIndex={0}
              aria-describedby={reasonId}
              className={cn('outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&>*]:pointer-events-none', className)}
              onPointerUp={(event) => {
                if (event.pointerType !== 'mouse') setTapOpen(true);
              }}
              onBlur={() => setTapOpen(false)}
            />
          }
        >
          {children(true)}
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">{reason}</span>
    </>
  );
}
