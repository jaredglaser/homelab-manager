import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import SyncStatusBadge from '../SyncStatusBadge';

describe('SyncStatusBadge', () => {
  it('renders "In Sync" for in-sync status', () => {
    render(<SyncStatusBadge status="in-sync" />);
    expect(screen.getByText('In Sync')).toBeDefined();
  });

  it('renders "Pending" for pending status', () => {
    render(<SyncStatusBadge status="pending" />);
    expect(screen.getByText('Pending')).toBeDefined();
  });

  it('renders "Failed" for failed status', () => {
    render(<SyncStatusBadge status="failed" />);
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders "Unknown" for unknown status', () => {
    render(<SyncStatusBadge status="unknown" />);
    expect(screen.getByText('Unknown')).toBeDefined();
  });
});
