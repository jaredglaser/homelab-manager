import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

describe('Switch', () => {
  it('toggles checked state on click and reports changes', () => {
    const onCheckedChange = mock(() => {});
    render(<Switch aria-label="enable" onCheckedChange={onCheckedChange} />);
    const el = screen.getByRole('switch');
    expect(el.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(el);
    expect(el.getAttribute('aria-checked')).toBe('true');
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });

  it('supports controlled checked prop', () => {
    render(<Switch aria-label="enable" checked readOnly />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Checkbox', () => {
  it('toggles on click and reports changes', () => {
    const onCheckedChange = mock(() => {});
    render(<Checkbox aria-label="pick" onCheckedChange={onCheckedChange} />);
    const el = screen.getByRole('checkbox');
    expect(el.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(el);
    expect(el.getAttribute('aria-checked')).toBe('true');
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });
});

describe('Progress', () => {
  it('exposes value via progressbar role', () => {
    render(<Progress value={40} aria-label="usage" />);
    const el = screen.getByRole('progressbar');
    expect(el.getAttribute('aria-valuenow')).toBe('40');
  });
});

describe('Tooltip', () => {
  it('renders content when controlled open', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover me</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByText('Helpful text')).not.toBeNull();
  });

  it('does not render content when closed', () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>hover me</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.queryByText('Helpful text')).toBeNull();
  });
});
