import { useColorScheme } from '@mui/joy/styles';
import { IconButton } from '@mui/joy';
import { Moon, Sun } from 'lucide-react';

export default function ModeToggle() {
  const { mode, setMode } = useColorScheme();

  return (
    <IconButton
      variant="plain"
      size="sm"
      onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
      aria-label="Toggle dark mode"
    >
      {mode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </IconButton>
  );
}
