import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import StackActionBar from '../StackActionBar';

describe('StackActionBar', () => {
  const defaultProps = {
    onDeploy: mock(() => {}),
    onUpdate: mock(() => {}),
    onTeardown: mock(() => {}),
    onDelete: mock(() => {}),
    isDeploying: false,
  };

  it('renders all 4 buttons', () => {
    render(<StackActionBar {...defaultProps} />);
    expect(screen.getByText('Deploy')).toBeDefined();
    expect(screen.getByText('Update images')).toBeDefined();
    expect(screen.getByText('Teardown')).toBeDefined();
    expect(screen.getByText('Delete Stack')).toBeDefined();
  });

  it('buttons are enabled when not deploying', () => {
    render(<StackActionBar {...defaultProps} isDeploying={false} />);
    const deployBtn = screen.getByText('Deploy').closest('button');
    const updateBtn = screen.getByText('Update images').closest('button');
    const teardownBtn = screen.getByText('Teardown').closest('button');
    const deleteBtn = screen.getByText('Delete Stack').closest('button');
    expect(deployBtn?.disabled).toBe(false);
    expect(updateBtn?.disabled).toBe(false);
    expect(teardownBtn?.disabled).toBe(false);
    expect(deleteBtn?.disabled).toBe(false);
  });

  it('buttons are disabled when isDeploying is true', () => {
    render(<StackActionBar {...defaultProps} isDeploying={true} />);
    const deployBtn = screen.getByText('Deploy').closest('button');
    const updateBtn = screen.getByText('Update images').closest('button');
    const teardownBtn = screen.getByText('Teardown').closest('button');
    const deleteBtn = screen.getByText('Delete Stack').closest('button');
    expect(deployBtn?.disabled).toBe(true);
    expect(updateBtn?.disabled).toBe(true);
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

  it('calls onUpdate when Update images is clicked', () => {
    const onUpdate = mock(() => {});
    render(<StackActionBar {...defaultProps} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByText('Update images'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
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

  it('does not render a Force checkbox', () => {
    render(<StackActionBar {...defaultProps} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Force')).toBeNull();
  });
});
