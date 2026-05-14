import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import DeniedPage from '@/components/auth/DeniedPage';

describe('DeniedPage', () => {
  it('renders the access denied heading', () => {
    render(<DeniedPage />);
    expect(screen.getByText(/You don't have access to this application/)).toBeDefined();
  });

  it('renders descriptive OIDC role message', () => {
    render(<DeniedPage />);
    expect(
      screen.getByText(/Your account is not assigned to any recognized role in your OIDC provider/),
    ).toBeDefined();
  });

  it('renders contact administrator text', () => {
    render(<DeniedPage />);
    expect(
      screen.getByText(/Please contact your administrator to be added to the appropriate group/),
    ).toBeDefined();
  });
});
