import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { findOpenTooltip, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { render, screen, fireEvent } from '@testing-library/react';
import StackActionBar from '../StackActionBar';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';

beforeEach(() => {
  seedSession('admin');
});

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

  it('shows a viewer Update images disabled with the role reason, and a click calls nothing', async () => {
    seedSession('viewer');
    const onUpdate = mock(() => undefined);
    render(<StackActionBar {...defaultProps} onUpdate={onUpdate} />);
    const user = setupUser();
    const update = screen.getByRole('button', { name: 'Update images' });
    expect(update.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(update);
    await user.hover(update);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('lets an operator run Update images', () => {
    seedSession('operator');
    const onUpdate = mock(() => undefined);
    render(<StackActionBar {...defaultProps} onUpdate={onUpdate} />);
    const update = screen.getByRole('button', { name: 'Update images' });
    expect(update.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(update);
    expect(onUpdate).toHaveBeenCalledTimes(1);
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

  it('disables the actions and names the running deploy while the server holds an active row', () => {
    render(<StackActionBar {...defaultProps} activeDeploy={{ status: 'in_progress', action: 'update' }} />);
    expect(screen.getByRole('status').textContent).toBe('Image update in progress');
    for (const label of ['Deploy', 'Update images', 'Teardown', 'Delete Stack']) {
      expect(screen.getByText(label).closest('button')?.disabled).toBe(true);
    }
  });

  it('points at the Deploys tab when the active row is awaiting approval', () => {
    render(<StackActionBar {...defaultProps} activeDeploy={{ status: 'pending', action: 'deploy' }} />);
    expect(screen.getByRole('status').textContent).toBe('Deploy awaiting approval in the Deploys tab');
    for (const label of ['Deploy', 'Update images', 'Teardown', 'Delete Stack']) {
      expect(screen.getByText(label).closest('button')?.disabled).toBe(true);
    }
  });

  it('renders no status note without an active deploy', () => {
    render(<StackActionBar {...defaultProps} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not render a Force checkbox', () => {
    render(<StackActionBar {...defaultProps} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Force')).toBeNull();
  });
});
