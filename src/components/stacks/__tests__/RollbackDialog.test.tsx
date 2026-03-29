import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import RollbackDialog from '../RollbackDialog';

function createProps(overrides?: Partial<Parameters<typeof RollbackDialog>[0]>) {
  return {
    open: true,
    onClose: mock(() => {}),
    onConfirm: mock(() => {}),
    stackName: 'plex',
    commitSha: 'a1b2c3d4e5f6',
    ...overrides,
  };
}

describe('RollbackDialog', () => {
  it('renders stack name in title', () => {
    render(<RollbackDialog {...createProps()} />);
    expect(screen.getByText('Rollback plex?')).toBeDefined();
  });

  it('renders commit SHA in body', () => {
    render(<RollbackDialog {...createProps()} />);
    expect(screen.getByText('a1b2c3d4e5f6')).toBeDefined();
  });

  it('renders descriptive body text', () => {
    render(<RollbackDialog {...createProps()} />);
    expect(
      screen.getByText((content) =>
        content.includes('Containers will be recreated with the previous compose configuration'),
      ),
    ).toBeDefined();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = mock(() => {});
    render(<RollbackDialog {...createProps({ onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when Confirm Rollback is clicked', () => {
    const onConfirm = mock(() => {});
    render(<RollbackDialog {...createProps({ onConfirm })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rollback' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Confirm Rollback button has destructive red styling', () => {
    render(<RollbackDialog {...createProps()} />);
    const btn = screen.getByRole('button', { name: 'Confirm Rollback' });
    expect(btn.className).toContain('red');
  });

  it('does not render when open is false', () => {
    render(<RollbackDialog {...createProps({ open: false })} />);
    expect(screen.queryByText('Rollback plex?')).toBeNull();
  });
});
