import { useColorScheme } from '@mui/material/styles';
import { IconButton } from '@mui/material';
import { Moon, Sun } from 'lucide-react';

export default function ModeToggle() {
  const { mode, setMode } = useColorScheme();

  return (
    <IconButton
      size="small"
      onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
      aria-label="Toggle dark mode"
    >
      {mode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </IconButton>
  );
}
