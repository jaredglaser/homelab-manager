import { createTheme } from '@mui/material/styles';

// Augment Material's TypeBackground to support Joy-like hierarchical backgrounds
declare module '@mui/material/styles' {
  interface TypeBackground {
    popup: string;
    level1: string;
    level2: string;
    level3: string;
    chartBg: string;
  }
}

const theme = createTheme({
  cssVariables: { colorSchemeSelector: '[data-color-scheme="%s"]' },
  colorSchemes: {
    light: {
      palette: {
        background: {
          default: '#e3eaf3',
          paper: '#d8e1ee',
          popup: '#cdd8e8',
          level1: '#c2cfe2',
          level2: '#b8c6db',
          level3: '#adbdd5',
          chartBg: '#edf2fb',
        },
      },
    },
    dark: {
      palette: {
        background: {
          default: '#121212',
          paper: '#1e1e1e',
          popup: '#2a2a2a',
          level1: '#252525',
          level2: '#2c2c2c',
          level3: '#333333',
          chartBg: '#1a1a1a',
        },
      },
    },
  },
  typography: {
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
});

export default theme;
