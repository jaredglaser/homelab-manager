import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import * as useMediaQueryModule from '@/hooks/useMediaQuery';
import IconGrid from '../IconGrid';

let origGetBCR: typeof HTMLElement.prototype.getBoundingClientRect;
let origFetch: typeof globalThis.fetch;
const origDescriptors = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};

beforeEach(() => {
  origGetBCR = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 800, height: 600, top: 0, right: 800, bottom: 600, left: 0, toJSON: () => '' };
  };
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 600; } });
  // IconCell calls fetch in useLayoutEffect; stub it out so the test environment
  // doesn't generate act() warnings from async failure paths.
  origFetch = globalThis.fetch;
  globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = origGetBCR;
  globalThis.fetch = origFetch;
  for (const prop of ['clientHeight', 'scrollHeight', 'offsetHeight'] as const) {
    const desc = origDescriptors[prop];
    if (desc) {
      Object.defineProperty(HTMLElement.prototype, prop, desc);
    } else {
      // Descriptor didn't exist originally: delete the test-installed getter so it doesn't leak to other tests.
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
});

describe('IconGrid', () => {
  it('renders icons from filteredIcons', () => {
    render(
      <IconGrid
        filteredIcons={['nginx', 'redis']}
        currentIcon={null}
        onSelect={() => {}}
        emptyMessage="No icons found"
      />,
    );
    expect(screen.getByAltText('nginx')).toBeDefined();
    expect(screen.getByAltText('redis')).toBeDefined();
  });

  it('renders emptyMessage when filteredIcons is empty', () => {
    render(
      <IconGrid
        filteredIcons={[]}
        currentIcon={null}
        onSelect={() => {}}
        emptyMessage="Nothing matched"
      />,
    );
    expect(screen.getByText('Nothing matched')).toBeDefined();
  });

  it('calls onSelect with the slug when an icon is clicked', () => {
    const onSelect = mock((_slug: string) => {});
    render(
      <IconGrid
        filteredIcons={['nginx', 'redis']}
        currentIcon={null}
        onSelect={onSelect}
        emptyMessage=""
      />,
    );
    const img = screen.getByAltText('nginx');
    const btn = img.closest('button');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onSelect).toHaveBeenCalledWith('nginx');
  });

  it('highlights the currentIcon', () => {
    render(
      <IconGrid
        filteredIcons={['nginx', 'redis']}
        currentIcon="nginx"
        onSelect={() => {}}
        emptyMessage=""
      />,
    );
    const selected = screen.getByAltText('nginx').closest('button');
    const other = screen.getByAltText('redis').closest('button');
    expect(selected!.className).toContain('bg-blue-500/20');
    expect(other!.className).not.toContain('bg-blue-500/20');
  });

  it('image onLoad transitions the cell to the loaded state', () => {
    render(
      <IconGrid
        filteredIcons={['nginx']}
        currentIcon={null}
        onSelect={() => {}}
        emptyMessage=""
      />,
    );
    const img = screen.getByAltText('nginx') as HTMLImageElement;
    expect(img.className).toContain('invisible');
    fireEvent.load(img);
    expect(img.className).toContain('visible');
  });

  it('image onError also transitions to the loaded state', () => {
    render(
      <IconGrid
        filteredIcons={['redis']}
        currentIcon={null}
        onSelect={() => {}}
        emptyMessage=""
      />,
    );
    const img = screen.getByAltText('redis') as HTMLImageElement;
    fireEvent.error(img);
    expect(img.className).toContain('visible');
  });

  it('chunks icons into rows of 7 columns by default (before the container is measured)', () => {
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const { container } = render(
      <IconGrid
        filteredIcons={eight}
        currentIcon={null}
        onSelect={() => {}}
        emptyMessage=""
      />,
    );
    for (const slug of eight) {
      expect(screen.getByAltText(slug)).toBeDefined();
    }
    const grid = container.querySelector('[style*="grid-template-columns"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(7, minmax(0, 1fr))');
  });

  it('derives a narrower column count from the measured container width', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {
        if (resizeCallback) {
          resizeCallback(
            [{ contentRect: { width: 300 } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const { container } = render(
        <IconGrid
          filteredIcons={eight}
          currentIcon={null}
          onSelect={() => {}}
          emptyMessage=""
        />,
      );
      for (const slug of eight) {
        expect(screen.getByAltText(slug)).toBeDefined();
      }
      const grid = container.querySelector('[style*="grid-template-columns"]') as HTMLElement;
      expect(grid.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('applies the tap-target utility on touch devices', () => {
    const isTouchSpy = spyOn(useMediaQueryModule, 'useIsTouch').mockReturnValue(true);
    try {
      render(
        <IconGrid
          filteredIcons={['nginx']}
          currentIcon={null}
          onSelect={() => {}}
          emptyMessage=""
        />,
      );
      const btn = screen.getByAltText('nginx').closest('button');
      expect(btn!.className).toContain('tap-target');
    } finally {
      isTouchSpy.mockRestore();
    }
  });

  it('omits the tap-target utility on non-touch devices', () => {
    const isTouchSpy = spyOn(useMediaQueryModule, 'useIsTouch').mockReturnValue(false);
    try {
      render(
        <IconGrid
          filteredIcons={['nginx']}
          currentIcon={null}
          onSelect={() => {}}
          emptyMessage=""
        />,
      );
      const btn = screen.getByAltText('nginx').closest('button');
      expect(btn!.className).not.toContain('tap-target');
    } finally {
      isTouchSpy.mockRestore();
    }
  });

  it('clamps the column count to a minimum of 3 at very narrow widths', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {
        if (resizeCallback) {
          resizeCallback(
            [{ contentRect: { width: 120 } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const { container } = render(
        <IconGrid
          filteredIcons={['a', 'b', 'c']}
          currentIcon={null}
          onSelect={() => {}}
          emptyMessage=""
        />,
      );
      const grid = container.querySelector('[style*="grid-template-columns"]') as HTMLElement;
      expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
