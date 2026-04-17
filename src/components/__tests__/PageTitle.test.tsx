import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import PageTitle from '../PageTitle';

describe('PageTitle', () => {
  it('renders the title text', () => {
    render(<PageTitle title="Settings" />);
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('renders arbitrary title strings', () => {
    render(<PageTitle title="My Dashboard" />);
    expect(screen.getByText('My Dashboard')).toBeDefined();
  });

  it('renders title in an h4 element', () => {
    render(<PageTitle title="Settings" />);
    const heading = screen.getByRole('heading', { level: 4 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe('Settings');
  });
});
