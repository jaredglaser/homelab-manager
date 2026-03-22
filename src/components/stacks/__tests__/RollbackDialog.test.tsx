import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import RollbackDialog from '../RollbackDialog';

const defaultProps = {
  open: true,
  onClose: mock(() => {}),
  onConfirm: mock(() => {}),
  stackName: 'plex',
  commitSha: 'a1b2c3d4e5f6',
};

describe('RollbackDialog', () => {
  it('renders stack name in title', () => {
    render(<RollbackDialog {...defaultProps} />);
    expect(screen.getByText('Rollback plex?')).toBeDefined();
  });

  it('renders commit SHA in body', () => {
    render(<RollbackDialog {...defaultProps} />);
    expect(screen.getByText('a1b2c3d4e5f6')).toBeDefined();
  });

  it('renders descriptive body text', () => {
    render(<RollbackDialog {...defaultProps} />);
    expect(
      screen.getByText((content) =>
        content.includes('Containers will be recreated with the previous compose configuration'),
      ),
    ).toBeDefined();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = mock(() => {});
    render(<RollbackDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when Confirm Rollback is clicked', () => {
    const onConfirm = mock(() => {});
    render(<RollbackDialog {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Confirm Rollback'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Confirm Rollback button has destructive red styling', () => {
    render(<RollbackDialog {...defaultProps} />);
    const btn = screen.getByText('Confirm Rollback').closest('button');
    expect(btn?.className).toMatch(/red/);
  });

  it('does not render when open is false', () => {
    render(<RollbackDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Rollback plex?')).toBeNull();
  });
});
