import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders a button with default (contained) styling and handles clicks', () => {
    const onClick = mock(() => {});
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('bg-primary');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies variant and size classes', () => {
    render(
      <Button variant="ghost" size="icon" aria-label="close">
        x
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'close' });
    expect(button.className).toContain('rounded-full');
    expect(button.className).not.toContain('bg-primary ');
  });

  it('does not fire clicks when disabled', () => {
    const onClick = mock(() => {});
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
