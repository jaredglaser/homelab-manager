import { describe, it, expect, mock, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntervalToggle } from '@/components/proxmox/ProxmoxIntervalToggle';

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

describe('IntervalToggle on a mouse pointer', () => {
  it('does not reveal the tooltip on click, leaving hover as the only way to open it', () => {
    setTouch(false);
    render(<IntervalToggle interval={1000} onIntervalChange={mock()} />);

    const fastButton = screen.getByRole('button', { name: '1 second (fast)' });
    fireEvent.click(fastButton);
    expect(screen.queryByText('Fast updates (1 second)')).toBeNull();
  });

  it('still selects the interval on click', () => {
    setTouch(false);
    const onIntervalChange = mock();
    render(<IntervalToggle interval={1000} onIntervalChange={onIntervalChange} />);

    fireEvent.click(screen.getByRole('button', { name: '10 seconds (relaxed)' }));
    expect(onIntervalChange).toHaveBeenCalledWith(10000);
  });
});

describe('IntervalToggle on a touch pointer', () => {
  it('reveals the tooltip content on tap and still selects the interval', () => {
    setTouch(true);
    const onIntervalChange = mock();
    render(<IntervalToggle interval={1000} onIntervalChange={onIntervalChange} />);

    expect(screen.queryByText('Relaxed updates (10 seconds)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '10 seconds (relaxed)' }));

    expect(screen.getByText('Relaxed updates (10 seconds)')).not.toBeNull();
    expect(screen.getByText('Recommended for most users')).not.toBeNull();
    expect(onIntervalChange).toHaveBeenCalledWith(10000);
  });

  it('dismisses the tooltip on a second tap of the same trigger', () => {
    setTouch(true);
    render(<IntervalToggle interval={1000} onIntervalChange={mock()} />);

    const fastButton = screen.getByRole('button', { name: '1 second (fast)' });
    fireEvent.click(fastButton);
    expect(screen.getByText('Fast updates (1 second)')).not.toBeNull();
    fireEvent.click(fastButton);
    expect(screen.queryByText('Fast updates (1 second)')).toBeNull();
  });

  it('dismisses the tooltip on a tap elsewhere', () => {
    setTouch(true);
    render(<IntervalToggle interval={1000} onIntervalChange={mock()} />);
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    const fastButton = screen.getByRole('button', { name: '1 second (fast)' });
    fireEvent.click(fastButton);
    expect(screen.getByText('Fast updates (1 second)')).not.toBeNull();

    fireEvent.pointerDown(outside);
    expect(screen.queryByText('Fast updates (1 second)')).toBeNull();

    outside.remove();
  });

  it('keeps the two triggers as direct siblings so rounded-corner classes still apply', () => {
    setTouch(true);
    render(<IntervalToggle interval={1000} onIntervalChange={mock()} />);

    const fastButton = screen.getByRole('button', { name: '1 second (fast)' });
    const relaxedButton = screen.getByRole('button', { name: '10 seconds (relaxed)' });
    expect(fastButton.parentElement).toBe(relaxedButton.parentElement);
  });
});
