import { useColorScheme } from '@mui/material/styles';
import { IconButton } from '@mui/material';
import { Moon, Sun } from 'lucide-react';

/**
 * Renders a button that toggles between light and dark color modes.
 *
 * @returns A clickable IconButton that switches the color scheme and shows a Sun icon when in dark mode or a Moon icon when in light mode.
 */
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
