import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountMenu } from '../menus';

describe('AccountMenu', () => {
  it('renders the account menu button', () => {
    render(<AccountMenu />);
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeDefined();
  });

  it('opens the menu on button click and shows Log out link', () => {
    render(<AccountMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menuitem', { name: /log out/i })).toBeDefined();
  });

  it('Log out link points to /api/auth/logout', () => {
    render(<AccountMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const link = screen.getByRole('menuitem', { name: /log out/i }) as HTMLAnchorElement;
    expect(link.href).toContain('/api/auth/logout');
  });
});
