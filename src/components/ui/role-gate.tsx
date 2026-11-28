import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRoleAccess, type RoleRequirement } from '@/hooks/useAuth';
import { cn } from '@/lib/utils/cn';

interface RoleGateProps {
  requires: RoleRequirement;
  /** Replaces the role's reason, for a control whose denial is about seeing rather than changing. */
  deniedReason?: string;
  /**
   * For a control that cannot take focus while blocked (a slider): a focusable wrapper named with this label stands in
   * for it. Without it, the control must stay focusable while blocked (a disabled tab, a read-only switch or select
   * trigger) and becomes the tooltip trigger itself.
   */
  wrapper?: { label: string; className?: string };
  children: (blocked: boolean) => ReactElement;
}

/** The `Button` `requires` gate for a control that is not a `Button`: the reason opens on hover, keyboard focus and tap. */
export function RoleGate({ requires, deniedReason, wrapper, children }: RoleGateProps) {
  const access = useRoleAccess(requires);
  const reasonId = useId();
  const [hoverOrFocusOpen, setHoverOrFocusOpen] = useState(false);
  const [tapOpen, setTapOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!tapOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node)) setTapOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress, true);
  }, [tapOpen]);

  if (access.kind === 'allowed') return children(false);
  if (access.kind === 'unknown') return children(true);
  const reason = deniedReason ?? access.reason;

  const triggerProps = {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
    },
    'aria-describedby': reasonId,
    onPointerUp: (event: ReactPointerEvent) => {
      // Base UI opens a tooltip only for a mouse hover or a keyboard focus, so a touch tap would never show why.
      if (event.pointerType !== 'mouse') setTapOpen(true);
    },
    onBlur: () => setTapOpen(false),
  };

  return (
    <>
      <Tooltip
        open={hoverOrFocusOpen || tapOpen}
        onOpenChange={(next, details) => {
          setHoverOrFocusOpen(next);
          if (!next && details.reason !== 'trigger-press' && details.reason !== 'trigger-hover') setTapOpen(false);
        }}
      >
        {wrapper ? (
          <TooltipTrigger
            {...triggerProps}
            render={
              <span
                data-slot="role-gate"
                role="group"
                aria-label={wrapper.label}
                tabIndex={0}
                // The blocked control takes no pointer events, so hover and tap land on the wrapper.
                className={cn('cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&>*]:pointer-events-none', wrapper.className)}
              />
            }
          >
            {children(true)}
          </TooltipTrigger>
        ) : (
          <TooltipTrigger {...triggerProps} render={children(true)} />
        )}
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">{reason}</span>
    </>
  );
}
