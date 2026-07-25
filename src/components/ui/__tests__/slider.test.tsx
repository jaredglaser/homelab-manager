import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { Slider } from '@/components/ui/slider';

describe('Slider', () => {
  it('renders a slider with the given value', () => {
    render(<Slider value={500} onValueChange={() => {}} min={100} max={60000} aria-label="interval" />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('aria-valuenow')).toBe('500');
  });

  it('snaps keyboard changes to the nearest mark', () => {
    const onValueChange = mock(() => {});
    render(
      <Slider
        value={1000}
        onValueChange={onValueChange}
        min={100}
        max={60000}
        marks={[100, 250, 500, 1000, 2000, 5000]}
        aria-label="interval"
      />,
    );
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalled();
    const reported = (onValueChange.mock.calls[0] as unknown[])[0];
    expect([100, 250, 500, 1000, 2000, 5000]).toContain(reported as number);
  });

  it('marks the control disabled when asked', () => {
    render(<Slider value={24} onValueChange={() => {}} min={1} max={168} disabled aria-label="raw" />);
    const slider = screen.getByRole('slider');
    expect(slider.hasAttribute('disabled')).toBe(true);
    expect(slider.closest('[data-slot="slider"]')?.hasAttribute('data-disabled')).toBe(true);
  });

  it('leaves the control enabled by default', () => {
    render(<Slider value={24} onValueChange={() => {}} min={1} max={168} aria-label="raw" />);
    expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(false);
  });

  it('passes values through unchanged without marks', () => {
    const onValueChange = mock(() => {});
    render(<Slider value={10} onValueChange={onValueChange} min={0} max={100} aria-label="plain" />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalledWith(11);
  });
});
