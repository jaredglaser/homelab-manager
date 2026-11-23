import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import '@/lib/test/testing-library';
import { Button } from '@/components/ui/button';
import { OPERATOR_DENIED_COPY, VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import { clearSession, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { mockModule } from '@/lib/test/mock-module';
import type * as AuthFunctions from '@/data/auth.functions';

mockModule<typeof AuthFunctions>('@/data/auth.functions', (real) => ({
  ...real,
  getSession: () => new Promise(() => {}),
}));

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

describe('Button role requirement', () => {
  afterEach(() => {
    clearSession();
  });

  it('pins the role copy', () => {
    expect(VIEWER_DENIED_COPY).toBe('Your role can view but not change things. Ask an operator or admin.');
    expect(OPERATOR_DENIED_COPY).toBe('Only an admin can do this.');
  });

  it.each([
    ['viewer', 'write', VIEWER_DENIED_COPY],
    ['viewer', 'admin', VIEWER_DENIED_COPY],
    ['operator', 'admin', OPERATOR_DENIED_COPY],
  ] as const)('disables a %s on a %s action, names the reason on focus, and swallows the click', async (role, requires, copy) => {
    seedSession(role);
    const onClick = mock(() => {});
    render(<Button requires={requires} onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.focus(button);
    expect((await screen.findByText(copy)).textContent).toBe(copy);
  });

  it('opens the reason on hover', async () => {
    seedSession('viewer');
    const user = setupUser();
    render(<Button requires="write">Save</Button>);
    await user.hover(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(VIEWER_DENIED_COPY)).toBeDefined();
  });

  it.each([
    ['operator', 'write'],
    ['admin', 'write'],
    ['admin', 'admin'],
    ['auth-disabled', 'admin'],
  ] as const)('lets a %s use a %s action', (as, requires) => {
    seedSession(as);
    const onClick = mock(() => {});
    render(<Button requires={requires} onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows its own label to a role that may use it', async () => {
    seedSession('operator');
    render(<Button requires="write" tooltip="Pulls newer images">Update</Button>);
    fireEvent.focus(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Pulls newer images')).toBeDefined();
  });

  it('stays disabled with no role reason while the session is loading', () => {
    clearSession();
    render(<Button requires="write">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.focus(button);
    expect(screen.queryByText(VIEWER_DENIED_COPY)).toBeNull();
  });

  it('is disabled with no role reason when only another reason applies', () => {
    seedSession('admin');
    const onClick = mock(() => {});
    render(<Button requires="write" disabled onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByText(VIEWER_DENIED_COPY)).toBeNull();
  });

  it('keeps the role reason when another reason also disables it', async () => {
    seedSession('viewer');
    render(<Button requires="write" disabled>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.focus(button);
    expect(await screen.findByText(VIEWER_DENIED_COPY)).toBeDefined();
  });
});
