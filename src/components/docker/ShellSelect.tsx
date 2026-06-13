import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { IS_DEMO_MODE } from '@/lib/constants/demo';
import { cn } from '@/lib/utils/cn';

const SHELL_OPTIONS = ['bash', 'sh', 'ash', 'zsh'] as const;

interface ShellSelectProps {
  /** Current shell: 'auto' or one of the SHELL_OPTIONS. */
  value: string;
  /** Emits the chosen value ('auto' or a shell name). */
  onChange: (value: string) => void;
  /** Shell the agent auto-detected, shown as `auto (<shell>)` once known. */
  resolvedShell?: string;
  className?: string;
}

/**
 * Compact shell picker for the logs/terminal toolbars. While `value` is `auto`
 * and the agent has not yet reported the resolved shell, the trigger shows a
 * spinner next to `auto` (the agent resolves it via a `{type:'shell'}` control
 * frame). Disabled in demo mode, where no real shell exists.
 */
export default function ShellSelect({ value, onChange, resolvedShell, className }: ShellSelectProps) {
  const renderDisplay = (current: string | null) => {
    if (IS_DEMO_MODE) return 'auto (demo)';
    const setting = current || 'auto';
    if (setting !== 'auto') return setting;
    if (resolvedShell) return `auto (${resolvedShell})`;
    return (
      <span className="inline-flex items-center gap-1.5">
        auto
        <Spinner className="size-2.5 text-(--muted-foreground)" />
      </span>
    );
  };

  return (
    <Select value={value} onValueChange={(val) => onChange(val ?? 'auto')} disabled={IS_DEMO_MODE}>
      <SelectTrigger aria-label="Shell" className={cn('h-8 min-w-[90px] text-xs', className)}>
        <SelectValue>{(current: string | null) => renderDisplay(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto" className="text-xs">
          auto
        </SelectItem>
        {SHELL_OPTIONS.map((s) => (
          <SelectItem key={s} value={s} className="text-xs">
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
