import type { ComponentProps } from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils/cn';

/* Styled like MUI outlined TextField size="small": 40px tall, divider border,
   2px primary border when focused. */
function Input({ className, ...props }: ComponentProps<typeof InputPrimitive>) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-lg border border-foreground/25 bg-transparent px-3 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground hover:border-foreground focus:border-primary focus:ring-1 focus:ring-primary disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
