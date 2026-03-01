import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import theme from '../theme';

/**
 * Wraps children with the application's Material UI theme provider and baseline, using the app theme with dark mode as the default.
 *
 * @param children - Content to render inside the themed provider
 * @returns A JSX element that provides the MUI theme and global CssBaseline and renders `children`
 */
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <MuiThemeProvider theme={theme} defaultMode="dark">
      <CssBaseline />
      {children}
    </MuiThemeProvider>
  );
}
