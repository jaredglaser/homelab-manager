import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { settingsAtom, type LightPalette } from './settingsAtom';

interface PaletteTokens {
  body: string;
  surface: string;
  popup: string;
  level1: string;
  level2: string;
  level3: string;
  chartBg: string;
}

const PALETTE_MAP: Record<LightPalette, PaletteTokens> = {
  'cool-blue': {
    body: '#e3eaf3', surface: '#d8e1ee', popup: '#cdd8e8',
    level1: '#c2cfe2', level2: '#b0bdd3', level3: '#9dacc3',
    chartBg: '#edf2fb',
  },
  'warm-slate': {
    body: '#ede8e3', surface: '#e4ddd7', popup: '#dbd3cc',
    level1: '#d1c9c2', level2: '#bfb7ae', level3: '#aba29a',
    chartBg: '#f4f0eb',
  },
  'forest-mist': {
    body: '#e2eae5', surface: '#d6e0db', popup: '#cad6d0',
    level1: '#beccc6', level2: '#aab8b2', level3: '#95a39d',
    chartBg: '#ecf3ee',
  },
  'soft-stone': {
    body: '#ebebeb', surface: '#e0e0e0', popup: '#d5d5d5',
    level1: '#c9c9c9', level2: '#b8b8b8', level3: '#a5a5a5',
    chartBg: '#f3f3f3',
  },
  'dusty-rose': {
    body: '#f0e9e9', surface: '#e8dede', popup: '#e0d4d4',
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
    el.textContent = `[data-joy-color-scheme="light"] {
  --joy-palette-background-body: ${t.body};
  --joy-palette-background-surface: ${t.surface};
  --joy-palette-background-popup: ${t.popup};
  --joy-palette-background-level1: ${t.level1};
  --joy-palette-background-level2: ${t.level2};
  --joy-palette-background-level3: ${t.level3};
  --joy-palette-neutral-softBg: ${t.chartBg};
}`;
  }, [palette]);
}
