import type { ComponentProps, ReactNode } from 'react';
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
  if ('requires' in props && props.requires) return <RoleGatedButton {...props} />;
  const { className, variant, size, ...rest } = props;
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
}

function RoleGatedButton({ requires, tooltip, className, variant, size, disabled, ...props }: RoleGatedButtonProps) {
  const access = useRoleAccess(requires);
  const roleBlocked = access.kind !== 'allowed';
  const content = access.kind === 'denied' ? access.reason : tooltip;
  // aria-disabled instead of the native attribute, so hover and focus still reach the trigger and open the reason.
  const button = (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || roleBlocked}
      focusableWhenDisabled={roleBlocked}
      {...props}
    />
  );
  if (!content) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent className="max-w-xs">{content}</TooltipContent>
    </Tooltip>
  );
}

export { Button, buttonVariants };
