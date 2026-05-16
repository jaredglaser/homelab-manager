import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Terminal as TerminalType, ITerminalOptions } from '@xterm/xterm';
import { getCssVar } from '@/lib/charts/css-vars';
import { RESIZE_DEBOUNCE_MS } from '@/lib/constants/ui-timing';

// xterm has no native wordWrap option — wrapping is controlled by cols width.
// Used as the initial cols when the buffer is empty and as an upper bound.
const NO_WRAP_COLS = 512;
// Padding beyond the longest line so the cursor/last char isn't flush against the edge.
const NO_WRAP_PADDING = 10;

function getBufferMaxWidth(term: TerminalType): number {
  const buffer = term.buffer.active;
  let max = 0;
  let currentLen = 0;
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const segLen = line.translateToString(true).length;
    // isWrapped=true means this segment continues the previous logical line.
    // Accumulate wrapped segments; reset on the start of each new logical line.
    currentLen = line.isWrapped ? currentLen + segLen : segLen;
    if (currentLen > max) max = currentLen;
  }
  return max;
}

interface UseXtermSetupResult {
  containerRef: RefObject<HTMLDivElement | null>;
  terminal: TerminalType | null;
  /** Set when the dynamic `@xterm/xterm` import or terminal construction fails (CSP, chunk hash mismatch after deploy, network blip). Lets the parent show an error instead of spinning on the skeleton forever. */
  error: Error | null;
  /**
   * Toggle word wrap. When disabled, cols is sized to the widest line in the
   * buffer (expanding dynamically as new lines arrive). The parent container
   * must set `overflow-x: auto; overflow-y: hidden` to provide horizontal
   * scroll (xterm has no native horizontal scroll widget). When enabled,
   * FitAddon refits to the container width. Safe to call before the terminal
   * is ready — applies on the next render once terminal state is available.
   */
  setWordWrap: (enabled: boolean) => void;
}

export function useXtermSetup(options: ITerminalOptions): UseXtermSetupResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<TerminalType | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const terminalRef = useRef<TerminalType | null>(null);
  const fitAddonRef = useRef<{ fit(): void } | null>(null);
  const wordWrapEnabledRef = useRef(true);
  // Disposable for the onLineFeed listener used to expand cols in no-wrap mode.
  const lineFeedDisposableRef = useRef<{ dispose(): void } | null>(null);

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

        if (containerRef.current) term.open(containerRef.current);

        if (containerRef.current) {
          requestAnimationFrame(() => {
            try {
              fitAddon.fit();
              // If word wrap was disabled before the terminal was ready, apply it now.
              // fitAddon.fit() must run first to get the correct row count.
              if (!wordWrapEnabledRef.current) {
                const contentWidth = getBufferMaxWidth(term);
                const cols = contentWidth > 0 ? contentWidth + NO_WRAP_PADDING : NO_WRAP_COLS;
                term.resize(cols, term.rows);
              }
            } catch { /* not visible yet */ }
          });
        }

        terminalRef.current = term;
        setTerminal(term);
      } catch (err) {
        console.error('Failed to initialize terminal:', err);
        if (!disposed) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();

    return () => {
      disposed = true;
      fitAddonRef.current = null;
      lineFeedDisposableRef.current?.dispose();
      lineFeedDisposableRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  // options captured once at mount; changing options mid-session would require recreating the xterm instance
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
    // Log the first fit() failure once instead of silently swallowing every tick
    // forever. A persistently throwing fit() (renderer disposed, canvas detached)
    // would otherwise drop ResizeObserver fires into a black hole. After 3
    // consecutive failures we disconnect the observer: the terminal is in a
    // permanently broken state and continuing to call fit() can't recover it.
    let loggedFitError = false;
    let consecutiveFitErrors = 0;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        const fitAddon = fitAddonRef.current;
        const term = terminalRef.current;
        if (!fitAddon || !term) return;
        try {
          // Always fit to update row count when the container height changes.
          // FitAddon is a no-op when the container is display:none, so this is
          // safe to call regardless of tab visibility.
          fitAddon.fit();
          if (!wordWrapEnabledRef.current) {
            // In no-wrap mode fit() recalculated cols based on container width;
            // restore content-based cols while keeping the updated row count.
            const contentWidth = getBufferMaxWidth(term);
            const cols = contentWidth > 0 ? contentWidth + NO_WRAP_PADDING : NO_WRAP_COLS;
            term.resize(cols, term.rows);
          }
          consecutiveFitErrors = 0;
        } catch (err) {
          consecutiveFitErrors += 1;
          if (!loggedFitError) {
            loggedFitError = true;
            console.error('[useXtermSetup] fit() failed:', err);
          }
          if (consecutiveFitErrors >= 3) {
            observer.disconnect();
          }
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(containerRef.current);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
    };
  }, [terminal]);

  const setWordWrap = useCallback((enabled: boolean) => {
    wordWrapEnabledRef.current = enabled;
    const term = terminalRef.current;
    if (!term) return;
    if (enabled) {
      lineFeedDisposableRef.current?.dispose();
      lineFeedDisposableRef.current = null;
      try { fitAddonRef.current?.fit(); } catch { /* ignore if not yet visible */ }
    } else {
      const contentWidth = getBufferMaxWidth(term);
      const cols = contentWidth > 0 ? contentWidth + NO_WRAP_PADDING : NO_WRAP_COLS;
      term.resize(cols, term.rows);
      // Expand cols as new lines arrive so long lines don't wrap in no-wrap mode.
      lineFeedDisposableRef.current?.dispose();
      lineFeedDisposableRef.current = term.onLineFeed(() => {
        const t = terminalRef.current;
        if (!t || wordWrapEnabledRef.current) return;
        const buffer = t.buffer.active;
        const cursorAbsY = buffer.viewportY + buffer.cursorY;
        const cursorLine = buffer.getLine(cursorAbsY);
        if (cursorLine?.isWrapped) {
          // Soft wrap: a line overflowed current cols. Scan the full buffer to
          // find the true maximum logical line width (accounting for all isWrapped
          // segments) and resize once rather than growing incrementally.
          const maxWidth = getBufferMaxWidth(t);
          const needed = maxWidth + NO_WRAP_PADDING;
          if (needed > t.cols) t.resize(needed, t.rows);
        } else {
          // Hard line feed (\n): check if the just-completed line needs more room.
          const prevLine = buffer.getLine(Math.max(0, cursorAbsY - 1));
          if (!prevLine) return;
          const width = prevLine.translateToString(true).length + NO_WRAP_PADDING;
          if (width > t.cols) t.resize(width, t.rows);
        }
      });
    }
  }, []);

  return { containerRef, terminal, error, setWordWrap };
}
