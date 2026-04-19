import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import PageStatusBar from '../PageStatusBar';

describe('PageStatusBar', () => {
  it('renders left slot content', () => {
    render(<PageStatusBar left={<span>12 running</span>} />);
    expect(screen.getByText('12 running')).toBeDefined();
  });

  it('renders right slot content', () => {
    render(<PageStatusBar right={<button>Toggle</button>} />);
    expect(screen.getByText('Toggle')).toBeDefined();
  });

  it('renders both slots together', () => {
    render(<PageStatusBar left={<span>left content</span>} right={<span>right content</span>} />);
    expect(screen.getByText('left content')).toBeDefined();
    expect(screen.getByText('right content')).toBeDefined();
  });

  it('returns null when both slots are empty', () => {
    const { container } = render(<PageStatusBar />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when both slots are undefined', () => {
    const { container } = render(<PageStatusBar left={undefined} right={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders when only left slot is provided', () => {
    const { container } = render(<PageStatusBar left={<span>left only</span>} />);
    expect(container.firstChild).not.toBeNull();
  });

  it('renders when only right slot is provided', () => {
    const { container } = render(<PageStatusBar right={<span>right only</span>} />);
    expect(container.firstChild).not.toBeNull();
  });

  it('applies flex layout classes to the outer container', () => {
    const { container } = render(<PageStatusBar left={<span>x</span>} />);
    const outer = container.firstChild as HTMLElement;
    expect(outer.className).toContain('flex');
    expect(outer.className).toContain('items-center');
    expect(outer.className).toContain('justify-between');
  });
});
