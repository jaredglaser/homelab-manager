import { ThemeProvider as MuiThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import theme from '../theme';

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    // enableCssLayer wraps all emotion-generated MUI styles in @layer mui. App.css
    // declares the layer order (mui before utilities), so plain Tailwind utilities
    // override MUI component styles without the ! important postfix.
    <StyledEngineProvider enableCssLayer>
      <MuiThemeProvider theme={theme} defaultMode="dark">
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </StyledEngineProvider>
  );
}
