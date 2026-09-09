import { describe, it, expect, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { UpdateIndicator } from '@/components/proxmox/ProxmoxUpdateIndicator';
import { proxmoxLastUpdateAtom } from '@/hooks/settingsAtom';

const originalMatchMedia = window.matchMedia;

function setTouch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

function renderIndicator(lastUpdate: number) {
  const store = createStore();
  store.set(proxmoxLastUpdateAtom, lastUpdate);
  render(
    <Provider store={store}>
      <UpdateIndicator expectedInterval={1000} />
    </Provider>,
  );
  return screen.getByRole('status');
}

describe('ProxmoxUpdateIndicator', () => {
  it('exposes "No data yet" via aria-label before any update arrives', () => {
    renderIndicator(0);
    expect(screen.getByLabelText('No data yet')).not.toBeNull();
  });

  it('exposes the last-updated time via aria-label regardless of hover state', () => {
    const now = Date.now();
    const dot = renderIndicator(now);
    const expected = `Last updated: ${new Date(now).toLocaleTimeString()}`;
    expect(dot.getAttribute('aria-label')).toBe(expected);
  });

  it('reveals the tooltip on tap when the primary input is touch', () => {
    setTouch(true);
    const dot = renderIndicator(0);

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(dot);
    expect(screen.getByRole('tooltip').textContent).toBe('No data yet');
  });

  it('reveals the tooltip on hover when the primary input is a mouse', () => {
    setTouch(false);
    const dot = renderIndicator(0);

    fireEvent.mouseEnter(dot.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toBe('No data yet');
  });
});
