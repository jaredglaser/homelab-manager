import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { MOBILE_BREAKPOINT } from '@/lib/constants/breakpoints';
import StackActionBar from '../StackActionBar';

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

function renderBar(overrides: Partial<Parameters<typeof StackActionBar>[0]> = {}) {
  const props = {
    onDeploy: mock(() => {}),
    onUpdate: mock(() => {}),
    onTeardown: mock(() => {}),
    onDelete: mock(() => {}),
    isDeploying: false,
    ...overrides,
  };
  render(<StackActionBar {...props} />);
  return props;
}

function openSheet() {
  fireEvent.click(screen.getByRole('button', { name: 'More stack actions' }));
}

describe('StackActionBar below the lg breakpoint', () => {
  it('keeps Deploy inline and moves the remaining actions behind an overflow trigger', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /deploy/i })).toBeDefined();
    expect(screen.getByRole('button', { name: 'More stack actions' })).toBeDefined();
    expect(screen.queryByText('Delete Stack')).toBeNull();
    expect(screen.queryByText('Teardown')).toBeNull();
    expect(screen.queryByText('Update images')).toBeNull();
  });

  it('exposes the three overflow actions once the sheet is opened', () => {
    renderBar();
    openSheet();
    expect(screen.getByText('Update images')).toBeDefined();
    expect(screen.getByText('Teardown')).toBeDefined();
    expect(screen.getByText('Delete Stack')).toBeDefined();
  });

  it('states the update-images behavior inline, since a tooltip never opens on touch', () => {
    renderBar();
    openSheet();
    expect(screen.getByText(/pulls newer images for every service/i)).toBeDefined();
  });

  it('fires onDelete and closes the sheet when Delete Stack is tapped', () => {
    const { onDelete } = renderBar();
    openSheet();
    fireEvent.click(screen.getByText('Delete Stack'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Teardown')).toBeNull();
  });

  it('fires onTeardown when Teardown is tapped', () => {
    const { onTeardown } = renderBar();
    openSheet();
    fireEvent.click(screen.getByText('Teardown'));
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('fires onUpdate when Update images is tapped', () => {
    const { onUpdate } = renderBar();
    openSheet();
    fireEvent.click(screen.getByText('Update images'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('fires onDeploy from the inline Deploy button', () => {
    const { onDeploy } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /deploy/i }));
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it('disables the inline Deploy button and every sheet action while deploying', () => {
    renderBar({ isDeploying: true });
    expect(screen.getByRole('button', { name: /deploy/i })).toHaveProperty('disabled', true);
    openSheet();
    for (const label of ['Update images', 'Teardown', 'Delete Stack']) {
      expect(screen.getByText(label).closest('button')).toHaveProperty('disabled', true);
    }
  });

  it('gives the inline controls a 44px touch height', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /deploy/i }).className).toContain('h-11');
    expect(screen.getByRole('button', { name: 'More stack actions' }).className).toContain('size-11');
  });
});
