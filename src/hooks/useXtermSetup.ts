import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Terminal as TerminalType, ITerminalOptions } from '@xterm/xterm';
import { getCssVar } from '@/lib/charts/css-vars';
import { RESIZE_DEBOUNCE_MS } from '@/lib/constants/ui-timing';

interface UseXtermSetupResult {
  containerRef: RefObject<HTMLDivElement | null>;
  terminal: TerminalType | null;
}

export function useXtermSetup(options: ITerminalOptions): UseXtermSetupResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<TerminalType | null>(null);
  const terminalRef = useRef<TerminalType | null>(null);
  const fitAddonRef = useRef<{ fit(): void } | null>(null);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        const [xtermMod, fitMod] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        await import('@xterm/xterm/css/xterm.css');
        if (disposed) return;

        // Handle CJS default export (bun) vs ESM named export (Vite)
        const xtermAny = xtermMod as Record<string, unknown>;
        const Terminal = (xtermAny.Terminal ??
          (xtermAny.default as Record<string, unknown>).Terminal) as typeof TerminalType;
        const fitAny = fitMod as Record<string, unknown>;
        const FitAddon = (fitAny.FitAddon ??
          (fitAny.default as Record<string, unknown>).FitAddon) as new () => import('@xterm/xterm').ITerminalAddon & { fit(): void };

        const bg = getCssVar('--mui-palette-background-chartBg');
        const fg = getCssVar('--chart-text-muted');

        const term = new Terminal({
          fontSize: 12,
          fontFamily: 'monospace',
          scrollback: 2000,
          ...options,
          theme: {
            ...(bg && { background: bg }),
            ...(fg && { foreground: fg }),
          },
        });

        const fitAddon = new FitAddon();
        fitAddonRef.current = fitAddon;
        term.loadAddon(fitAddon);

        // containerRef.current is null in test environments (renderHook renders no DOM),
        // but the mock terminal's open() is a no-op so this is safe to call either way
        term.open(containerRef.current!);

        if (containerRef.current) {
          requestAnimationFrame(() => {
            try { fitAddon.fit(); } catch { /* not visible yet */ }
          });
        }

        terminalRef.current = term;
        setTerminal(term);
      } catch (err) {
        console.error('Failed to initialize terminal:', err);
      }
    })();

    return () => {
      disposed = true;
      fitAddonRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  // options captured once at mount — changing options mid-session would require recreating the xterm instance
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync terminal theme when the color scheme changes (xterm uses a canvas renderer,
  // so CSS variable changes don't apply automatically)
  useEffect(() => {
    if (!terminal) return;
    const root = document.documentElement;
    const applyTheme = () => {
      const bg = getCssVar('--mui-palette-background-chartBg');
      const fg = getCssVar('--chart-text-muted');
      terminal.options.theme = {
        ...(bg && { background: bg }),
        ...(fg && { foreground: fg }),
      };
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-color-scheme'] });
    return () => observer.disconnect();
  }, [terminal]);

  // Re-fit on container resize (debounced to avoid rapid reflows during Collapse animation).
  // containerRef.current is populated in real use (component renders <div ref={containerRef}>);
  // in test environments it may be null, so we guard against it.
  useEffect(() => {
    if (!fitAddonRef.current) return;
    if (!containerRef.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        try { fitAddonRef.current?.fit(); } catch { /* layout transition */ }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(containerRef.current);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
    };
  }, [terminal]);

  return { containerRef, terminal };
}
