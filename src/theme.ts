import { extendTheme } from '@mui/joy/styles';

const theme = extendTheme({
  fontFamily: {
    body: '"Inter", var(--joy-fontFamily-fallback, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol")',
    display: '"Inter", var(--joy-fontFamily-fallback, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol")',
  },
  colorSchemes: {
    light: {
      palette: {
        background: {
          body: '#e3eaf3',
          surface: '#d8e1ee',
          popup: '#cdd8e8',
          level1: '#c2cfe2',
          level2: '#b8c6db',
          level3: '#adbdd5',
        },
      },
    },
  },
});

export default theme;
