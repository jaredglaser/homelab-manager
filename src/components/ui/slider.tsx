import { useCallback } from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from '@/lib/utils/cn';

interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  /**
   * Snap-only values: the thumb can only land on these values. When omitted
   * the slider moves in steps of 1.
   */
  marks?: number[];
  'aria-label'?: string;
  className?: string;
}

function snapToMark(value: number, marks: number[]): number {
  let nearest = marks[0];
  for (const mark of marks) {
    if (Math.abs(mark - value) < Math.abs(nearest - value)) nearest = mark;
  }
  return nearest;
}

function Slider({ value, onValueChange, min, max, marks, className, ...props }: Readonly<SliderProps>) {
  const handleChange = useCallback(
    (next: number) => {
      onValueChange(marks && marks.length > 0 ? snapToMark(next, marks) : next);
    },
    [onValueChange, marks],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      onValueChange={handleChange}
      min={min}
      max={max}
      className={cn('w-full', className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-2 select-none">
        <SliderPrimitive.Track className="bg-primary/30 relative h-1 w-full rounded-full select-none">
          <SliderPrimitive.Indicator className="bg-primary rounded-full select-none" />
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            className="bg-primary size-5 rounded-full shadow outline-none transition-shadow select-none focus-visible:ring-4 focus-visible:ring-primary/30 hover:ring-4 hover:ring-primary/15"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
