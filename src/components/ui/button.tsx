import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRoleAccess, type RoleRequirement } from '@/hooks/useAuth';

/*
 * default = filled, outline = outlined, ghost = text. Uppercase + tracking
 * mirrors the MUI default to avoid visible regressions.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium uppercase tracking-[0.02857em] transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        outline: 'border border-primary/50 text-primary hover:bg-primary/5 hover:border-primary',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'text-primary hover:bg-primary/10',
        link: 'text-primary underline-offset-4 hover:underline normal-case tracking-normal',
      },
      size: {
        default: 'h-9 px-4 py-1.5',
        sm: 'h-8 px-3 text-[0.8125rem]',
        lg: 'h-10 px-6',
        icon: 'size-9 rounded-full normal-case',
        'icon-sm': 'size-8 rounded-full normal-case',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = ComponentProps<typeof ButtonPrimitive> & VariantProps<typeof buttonVariants>;

type RoleGatedButtonProps = ButtonProps & {
  /** The role a click needs. Any other role gets the button disabled with the reason in a tooltip. */
  requires: RoleRequirement;
  /** Shown on hover while the role may use the button. The role reason replaces it otherwise. */
  tooltip?: ReactNode;
};

function Button(props: ButtonProps | RoleGatedButtonProps) {
  if ('requires' in props) return <RoleGatedButton {...props} />;
  const { className, variant, size, ...rest } = props;
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
}

function RoleGatedButton({
  requires,
  tooltip,
  className,
  variant,
  size,
  disabled,
  ref,
  onPointerUp,
  onBlur,
  ...props
}: RoleGatedButtonProps) {
  const access = useRoleAccess(requires);
  const roleBlocked = access.kind !== 'allowed';
  const reason = access.kind === 'denied' ? access.reason : null;
  const content = reason ?? tooltip;
  const reasonId = useId();
  const [hoverOrFocusOpen, setHoverOrFocusOpen] = useState(false);
  const [tapOpen, setTapOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const setRefs = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  useEffect(() => {
    if (!tapOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) setTapOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress, true);
  }, [tapOpen]);

  // aria-disabled instead of the native attribute, so hover and focus still reach the trigger and open the reason.
  const button = (
    <ButtonPrimitive
      ref={setRefs}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || roleBlocked}
      focusableWhenDisabled={roleBlocked}
      aria-describedby={reason ? reasonId : undefined}
      onPointerUp={(event) => {
        // Base UI opens a tooltip only for a mouse hover or a keyboard focus, so a touch tap would never show why.
        // Pointer up, because a disabled Base UI button swallows pointer down.
        if (reason && event.pointerType !== 'mouse') setTapOpen(true);
        onPointerUp?.(event);
      }}
      onBlur={(event) => {
        setTapOpen(false);
        onBlur?.(event);
      }}
      {...props}
    />
  );
  if (!content) return button;
  return (
    <>
      <Tooltip
        open={hoverOrFocusOpen || tapOpen}
        onOpenChange={(next, details) => {
          setHoverOrFocusOpen(next);
          // A tap also reads to Base UI as a trigger press and an emulated hover ending, both reported as closes.
          if (!next && details.reason !== 'trigger-press' && details.reason !== 'trigger-hover') setTapOpen(false);
        }}
      >
        <TooltipTrigger render={button} />
        <TooltipContent className="max-w-xs">{content}</TooltipContent>
      </Tooltip>
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
    </>
  );
}

export { Button, buttonVariants };
