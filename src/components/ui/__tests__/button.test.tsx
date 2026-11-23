import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/test/testing-library';
import { Button } from '@/components/ui/button';
import { OPERATOR_DENIED_COPY, VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import { clearSession, findOpenTooltip, openTooltip, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { mockModule } from '@/lib/test/mock-module';
import type * as AuthFunctions from '@/data/auth.functions';

mockModule<typeof AuthFunctions>('@/data/auth.functions', (real) => ({
  ...real,
  getSession: () => new Promise(() => undefined),
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
  ] as const)('disables a %s on a %s action, names the reason on keyboard focus and to a screen reader, and swallows the click', async (role, requires, copy) => {
    seedSession(role);
    const user = setupUser();
    const onClick = mock(() => undefined);
    render(<><button type="button">before</button><Button requires={requires} onClick={onClick}>Save</Button></>);
    const button = screen.getByRole('button', { name: 'Save' });

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-describedby')).not.toBeNull();
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(copy);

    await user.click(button);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(button);
    expect(await findOpenTooltip()).toBe(copy);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('opens the reason on hover', async () => {
    seedSession('viewer');
    const user = setupUser();
    render(<Button requires="write">Save</Button>);
    await user.hover(screen.getByRole('button', { name: 'Save' }));
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
  });

  it('opens the reason on a touch tap and closes it on a press elsewhere', async () => {
    seedSession('viewer');
    const onClick = mock(() => undefined);
    render(<><Button requires="write" onClick={onClick}>Save</Button><p>elsewhere</p></>);
    const button = screen.getByRole('button', { name: 'Save' });

    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByText('elsewhere'), { pointerType: 'touch' });
    await waitFor(() => expect(openTooltip()).toBeNull());
  });

  it('closes a tapped reason when the button loses focus', async () => {
    seedSession('viewer');
    render(<Button requires="write">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);

    fireEvent.blur(button);
    await waitFor(() => expect(openTooltip()).toBeNull());
  });

  it('keeps a caller aria-describedby alongside the role reason', () => {
    seedSession('viewer');
    render(<><p id="hint">Applies to every host</p><Button requires="write" aria-describedby="hint">Save</Button></>);
    const ids = screen.getByRole('button', { name: 'Save' }).getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids).toContain('hint');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(VIEWER_DENIED_COPY);
  });

  it('treats requires={undefined} as no requirement', () => {
    seedSession('viewer');
    const onClick = mock(() => undefined);
    render(<Button requires={undefined} onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('opens no reason on a mouse press, which hover covers', async () => {
    seedSession('viewer');
    render(<Button requires="write">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    expect(openTooltip()).not.toBeNull();
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    await waitFor(() => expect(openTooltip()).toBeNull());

    fireEvent.pointerDown(button, { pointerType: 'mouse' });
    fireEvent.pointerUp(button, { pointerType: 'mouse' });
    expect(openTooltip()).toBeNull();
  });

  it.each([
    ['operator', 'write'],
    ['admin', 'write'],
    ['admin', 'admin'],
    ['auth-disabled', 'admin'],
  ] as const)('lets a %s use a %s action', (as, requires) => {
    seedSession(as);
    const onClick = mock(() => undefined);
    render(<Button requires={requires} onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows its own label to a role that may use it', async () => {
    seedSession('operator');
    const user = setupUser();
    render(<Button requires="write" tooltip="Pulls newer images">Update</Button>);
    await user.hover(screen.getByRole('button', { name: 'Update' }));
    expect(await findOpenTooltip()).toBe('Pulls newer images');
  });

  it('stays disabled with no role reason while the session is loading', async () => {
    clearSession();
    const user = setupUser();
    render(<Button requires="write">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBeNull();
    await user.hover(button);
    expect(openTooltip()).toBeNull();
  });

  it('is disabled with no role reason when only another reason applies', () => {
    seedSession('admin');
    const onClick = mock(() => undefined);
    render(<Button requires="write" disabled onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the role reason when another reason also disables it', async () => {
    seedSession('viewer');
    const user = setupUser();
    render(<Button requires="write" disabled>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.hover(button);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
  });
});
