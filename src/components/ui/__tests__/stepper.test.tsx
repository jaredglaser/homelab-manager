import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { Stepper } from '@/components/ui/stepper';

const STEPS = ['Capabilities', 'ZFS Setup', 'Compose File'] as const;

function installMatchMedia(matchesMobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matchesMobile && query === '(max-width: 1023px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

describe('Stepper above the lg breakpoint', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    installMatchMedia(false);
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('renders every step label', () => {
    render(<Stepper steps={STEPS} activeStep={1} />);
    for (const step of STEPS) {
      expect(screen.getByText(step)).not.toBeNull();
    }
  });

  it('does not render a separate active-step label', () => {
    render(<Stepper steps={STEPS} activeStep={1} />);
    expect(document.querySelector('[data-slot="stepper-active-label"]')).toBeNull();
  });
});

describe('Stepper below the lg breakpoint', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    installMatchMedia(true);
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('hides the per-step labels', () => {
    render(<Stepper steps={STEPS} activeStep={1} />);
    expect(document.querySelectorAll('[data-slot="stepper-label"]').length).toBe(0);
  });

  it('shows the active step name once, below the dots', () => {
    render(<Stepper steps={STEPS} activeStep={1} />);
    expect(screen.getByText('ZFS Setup')).not.toBeNull();
  });

  it('still renders one indicator dot per step', () => {
    render(<Stepper steps={STEPS} activeStep={1} />);
    const indicators = document.querySelectorAll('[data-slot="stepper-indicator"]');
    expect(indicators.length).toBe(STEPS.length);
  });
});
