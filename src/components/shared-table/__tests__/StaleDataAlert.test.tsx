import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { StaleDataAlert } from '../StaleDataAlert';

describe('StaleDataAlert', () => {
  it('renders the warning when isStale is true', () => {
    render(<StaleDataAlert isStale={true} />);
    expect(screen.getByText(/Data is stale/)).toBeDefined();
  });

  it('renders nothing when isStale is false', () => {
    const { container } = render(<StaleDataAlert isStale={false} />);
    expect(container.firstChild).toBeNull();
  });
});
