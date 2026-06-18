import { Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface StepperProps {
  steps: readonly string[];
  activeStep: number;
  className?: string;
}

/*
 * Numbered circles joined by connector lines with the label centered under
 * each circle. Purely
 * presentational; step state lives in the caller.
 */
function Stepper({ steps, activeStep, className }: Readonly<StepperProps>) {
  return (
    <div data-slot="stepper" className={cn('flex w-full', className)}>
      {steps.map((label, index) => {
        const isCompleted = index < activeStep;
        const isActive = index === activeStep;
        return (
          <div key={label} className="relative flex flex-1 flex-col items-center gap-2 px-2">
            {index > 0 && (
              <div
                aria-hidden
                className="absolute top-3 right-1/2 left-[calc(-50%+20px)] mr-5 h-px bg-border"
              />
            )}
            <span
              data-slot="stepper-indicator"
              className={cn(
                'z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                isActive || isCompleted
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-foreground/30 text-background',
              )}
            >
              {isCompleted ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
            </span>
            <span
              data-slot="stepper-label"
              className={cn(
                'text-center text-sm',
                isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export { Stepper };
