import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { settingsAtom, type LightPalette } from './settingsAtom';

interface PaletteTokens {
  default: string;
  paper: string;
  popup: string;
  level1: string;
  level2: string;
  level3: string;
  chartBg: string;
}

const PALETTE_MAP: Record<LightPalette, PaletteTokens> = {
  'cool-blue': {
    default: '#e3eaf3', paper: '#d8e1ee', popup: '#cdd8e8',
    level1: '#c2cfe2', level2: '#b0bdd3', level3: '#9dacc3',
    chartBg: '#edf2fb',
  },
  'warm-slate': {
    default: '#ede8e3', paper: '#e4ddd7', popup: '#dbd3cc',
    level1: '#d1c9c2', level2: '#bfb7ae', level3: '#aba29a',
    chartBg: '#f4f0eb',
  },
  'forest-mist': {
    default: '#e2eae5', paper: '#d6e0db', popup: '#cad6d0',
    level1: '#beccc6', level2: '#aab8b2', level3: '#95a39d',
    chartBg: '#ecf3ee',
  },
  'soft-stone': {
    default: '#ebebeb', paper: '#e0e0e0', popup: '#d5d5d5',
    level1: '#c9c9c9', level2: '#b8b8b8', level3: '#a5a5a5',
    chartBg: '#f3f3f3',
  },
  'dusty-rose': {
    default: '#f0e9e9', paper: '#e8dede', popup: '#e0d4d4',
    level1: '#d8c9c9', level2: '#c8b5b5', level3: '#b5a0a0',
    chartBg: '#f7f1f1',
  },
};

const STYLE_ID = 'light-palette-override';

export function useLightPaletteEffect(): void {
  const settings = useAtomValue(settingsAtom);
  const palette = settings.general.lightPalette;

  useEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }

    const t = PALETTE_MAP[palette];
    // Override the background-derived shadcn tokens for the selected light
    // palette. level1 backs --secondary, --muted, and --level1 (all three share
    // the same palette step). The fixed light tokens (foreground, primary,
    // border, etc.) stay in App.css; only these vary by palette.
    el.textContent = `[data-color-scheme="light"] {
  --background: ${t.default};
  --card: ${t.paper};
  --popover: ${t.popup};
  --secondary: ${t.level1};
  --muted: ${t.level1};
  --level1: ${t.level1};
  --level2: ${t.level2};
  --level3: ${t.level3};
  --chart-bg: ${t.chartBg};
}`;
  }, [palette]);
}
