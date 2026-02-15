import { extendTheme } from '@mui/joy/styles';

const theme = extendTheme({
  fontFamily: {
    body: '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
    display: '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  radius: {
    xs: '6px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '22px',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: {
          50: '#e8f1ff',
          100: '#c5daff',
          200: '#9ec0ff',
          300: '#70a3ff',
          400: '#4d8eff',
          500: '#007AFF',
          600: '#006ae6',
          700: '#0058cc',
          800: '#0045a3',
          900: '#003080',
        },
        background: {
          body: '#f5f5f7',
          surface: '#ffffff',
          level1: '#f5f5f7',
          level2: '#ebebed',
          level3: '#d2d2d7',
          popup: '#ffffff',
        },
        neutral: {
          50: '#fafafa',
          100: '#f5f5f7',
          200: '#e8e8ed',
          300: '#d2d2d7',
          400: '#aeaeb2',
          500: '#8e8e93',
          600: '#636366',
          700: '#48484a',
          800: '#3a3a3c',
          900: '#1d1d1f',
        },
        divider: 'rgba(0, 0, 0, 0.06)',
        text: {
          primary: '#1d1d1f',
          secondary: '#6e6e73',
          tertiary: '#aeaeb2',
        },
      },
    },
    dark: {
      palette: {
        primary: {
          50: '#001a40',
          100: '#002d6d',
          200: '#004090',
          300: '#0058cc',
          400: '#0a84ff',
          500: '#0a84ff',
          600: '#409cff',
          700: '#70b5ff',
          800: '#a0cfff',
          900: '#d0e8ff',
        },
        background: {
          body: '#000000',
          surface: '#1c1c1e',
          level1: '#2c2c2e',
          level2: '#3a3a3c',
          level3: '#48484a',
          popup: '#2c2c2e',
        },
        neutral: {
          50: '#1c1c1e',
          100: '#2c2c2e',
          200: '#3a3a3c',
          300: '#48484a',
          400: '#636366',
          500: '#8e8e93',
          600: '#aeaeb2',
          700: '#d2d2d7',
          800: '#e5e5ea',
          900: '#f5f5f7',
        },
        divider: 'rgba(255, 255, 255, 0.08)',
        text: {
          primary: '#f5f5f7',
          secondary: '#aeaeb2',
          tertiary: '#636366',
        },
      },
    },
  },
  shadow: {
    xs: '0 1px 2px rgba(0,0,0,0.04)',
    sm: '0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03)',
    md: '0 4px 8px -1px rgba(0,0,0,0.06), 0 2px 4px -2px rgba(0,0,0,0.04)',
    lg: '0 10px 25px -3px rgba(0,0,0,0.08), 0 4px 10px -4px rgba(0,0,0,0.04)',
    xl: '0 20px 40px -5px rgba(0,0,0,0.1), 0 8px 16px -6px rgba(0,0,0,0.06)',
  },
  components: {
    JoyCard: {
      styleOverrides: {
        root: {
          boxShadow: '0 1px 4px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.02)',
          borderColor: 'rgba(0,0,0,0.06)',
          transition: 'box-shadow 0.3s ease',
        },
      },
    },
    JoyChip: {
      styleOverrides: {
        root: {
          fontWeight: 500,
          borderRadius: '20px',
        },
      },
    },
    JoyModalDialog: {
      styleOverrides: {
        root: {
          boxShadow: '0 25px 60px rgba(0,0,0,0.15), 0 10px 20px rgba(0,0,0,0.08)',
          borderRadius: '16px',
        },
      },
    },
    JoyModal: {
      styleOverrides: {
        backdrop: {
          backdropFilter: 'blur(8px)',
          backgroundColor: 'rgba(0,0,0,0.25)',
        },
      },
    },
    JoyInput: {
      styleOverrides: {
        root: {
          transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
        },
      },
    },
  },
});

export default theme;
