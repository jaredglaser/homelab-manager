import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import StackActionBar from '../StackActionBar';

describe('StackActionBar', () => {
  const defaultProps = {
    onDeploy: mock(() => {}),
    onTeardown: mock(() => {}),
    onDelete: mock(() => {}),
    isDeploying: false,
    forceRecreate: false,
    onForceRecreateChange: mock(() => {}),
  };

  it('renders all 3 buttons', () => {
    render(<StackActionBar {...defaultProps} />);
    expect(screen.getByText('Deploy')).toBeDefined();
    expect(screen.getByText('Teardown')).toBeDefined();
    expect(screen.getByText('Delete Stack')).toBeDefined();
  });

  it('buttons are enabled when not deploying', () => {
    render(<StackActionBar {...defaultProps} isDeploying={false} />);
    const deployBtn = screen.getByText('Deploy').closest('button');
    const teardownBtn = screen.getByText('Teardown').closest('button');
    const deleteBtn = screen.getByText('Delete Stack').closest('button');
    expect(deployBtn?.disabled).toBe(false);
    expect(teardownBtn?.disabled).toBe(false);
    expect(deleteBtn?.disabled).toBe(false);
  });

  it('buttons are disabled when isDeploying is true', () => {
    render(<StackActionBar {...defaultProps} isDeploying={true} />);
    const deployBtn = screen.getByText('Deploy').closest('button');
    const teardownBtn = screen.getByText('Teardown').closest('button');
    const deleteBtn = screen.getByText('Delete Stack').closest('button');
    expect(deployBtn?.disabled).toBe(true);
    expect(teardownBtn?.disabled).toBe(true);
    expect(deleteBtn?.disabled).toBe(true);
  });

  it('shows spinner when deploying', () => {
    const { container } = render(<StackActionBar {...defaultProps} isDeploying={true} />);
    const spinner = container.querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
  });

  it('calls onDeploy when Deploy is clicked', () => {
    const onDeploy = mock(() => {});
    render(<StackActionBar {...defaultProps} onDeploy={onDeploy} />);
    fireEvent.click(screen.getByText('Deploy'));
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it('calls onTeardown when Teardown is clicked', () => {
    const onTeardown = mock(() => {});
    render(<StackActionBar {...defaultProps} onTeardown={onTeardown} />);
    fireEvent.click(screen.getByText('Teardown'));
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete when Delete Stack is clicked', () => {
    const onDelete = mock(() => {});
    render(<StackActionBar {...defaultProps} onDelete={onDelete} />);
    fireEvent.click(screen.getByText('Delete Stack'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('renders Force Recreate checkbox checked when forceRecreate is true', () => {
    render(<StackActionBar {...defaultProps} forceRecreate={true} />);
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('calls onForceRecreateChange when Force checkbox is clicked', () => {
    const onForceRecreateChange = mock(() => {});
    render(<StackActionBar {...defaultProps} onForceRecreateChange={onForceRecreateChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onForceRecreateChange).toHaveBeenCalledWith(true);
  });

  it('disables Force Recreate checkbox when isDeploying is true', () => {
    render(<StackActionBar {...defaultProps} isDeploying={true} />);
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  });
});
