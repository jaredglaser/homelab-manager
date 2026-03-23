import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import LoginPage from '../LoginPage';

describe('LoginPage', () => {
  it('renders the app name heading', () => {
    render(<LoginPage />);
    expect(screen.getByText('Homelab Manager')).toBeDefined();
  });

  it('renders a Sign in link pointing to /api/auth/login', () => {
    render(<LoginPage />);
    const link = screen.getByRole('link', { name: 'Sign in' });
    expect(link).toBeDefined();
    expect((link as HTMLAnchorElement).href).toContain('/api/auth/login');
  });
});
