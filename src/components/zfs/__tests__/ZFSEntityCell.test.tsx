import { describe, it, expect, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import ZFSEntityCell from '@/components/zfs/ZFSEntityCell';

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

describe('ZFSEntityCell', () => {
  it('renders the name and no badge when none is provided', () => {
    render(<ZFSEntityCell name="rust" entityType="pool" indent={0} />);
    expect(screen.getByText('rust')).not.toBeNull();
    expect(screen.queryByText(/single disk/)).toBeNull();
  });

  it('renders a badge without a tooltip trigger when the badge has no tooltip', () => {
    render(
      <ZFSEntityCell
        name="rust"
        entityType="pool"
        indent={0}
        badge={{ label: 'raidz2-0' }}
      />,
    );
    expect(screen.getByText('raidz2-0')).not.toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('exposes the tooltip text to screen readers regardless of hover state', () => {
    setTouch(false);
    render(
      <ZFSEntityCell
        name="system"
        entityType="pool"
        indent={0}
        badge={{ label: 'single disk', tooltip: 'sda' }}
      />,
    );
    expect(screen.getByText('single disk').textContent).toContain('sda');
  });

  it('reveals the disk name on tap when the primary input is touch', () => {
    setTouch(true);
    render(
      <ZFSEntityCell
        name="system"
        entityType="pool"
        indent={0}
        badge={{ label: 'single disk', tooltip: 'sda' }}
      />,
    );

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByText('single disk'));
    expect(screen.getByRole('tooltip').textContent).toBe('sda');
  });

  it('reveals the disk name on hover when the primary input is a mouse', () => {
    setTouch(false);
    render(
      <ZFSEntityCell
        name="system"
        entityType="pool"
        indent={0}
        badge={{ label: 'single disk', tooltip: 'sda' }}
      />,
    );

    const trigger = screen.getByText('single disk').parentElement as HTMLElement;
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('sda');
  });

  it('renders an expand chevron and the host server icon', () => {
    render(
      <ZFSEntityCell name="nas01" entityType="host" indent={0} canExpand isExpanded />,
    );
    expect(screen.getByText('nas01')).not.toBeNull();
  });
});
