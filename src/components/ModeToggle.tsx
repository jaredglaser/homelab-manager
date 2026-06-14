import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useColorMode } from '@/hooks/useColorMode';

export default function ModeToggle() {
  const { mode, toggle } = useColorMode();

  return (
    <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle dark mode">
      {mode === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </Button>
  );
}
