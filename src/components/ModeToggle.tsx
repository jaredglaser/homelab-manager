import { useColorScheme } from '@mui/joy/styles';
import { IconButton } from '@mui/joy';
import { Moon, Sun } from 'lucide-react';

export default function ModeToggle() {
  const { mode, setMode } = useColorScheme();

  return (
    <IconButton
      variant="soft"
      color="neutral"
      size="sm"
      onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
      aria-label="Toggle dark mode"
    >
      {mode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </IconButton>
  );
}
