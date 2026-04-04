import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import CreateStackDialog from '../CreateStackDialog';

const defaultHosts = ['server1', 'server2'];

const defaultProps = {
  open: true,
  onClose: mock(() => {}),
  onSubmit: mock(() => {}),
  hosts: defaultHosts,
  isLoading: false,
};

describe('CreateStackDialog', () => {
  it('renders stack name input', () => {
    render(<CreateStackDialog {...defaultProps} />);
    expect(screen.getByLabelText('Stack Name')).toBeDefined();
  });

  it('renders host select with provided hosts', () => {
    render(<CreateStackDialog {...defaultProps} />);
    expect(screen.getByText('server1')).toBeDefined();
  });

  it('renders deploy mode radio group', () => {
    render(<CreateStackDialog {...defaultProps} />);
    expect(screen.getByText('Auto')).toBeDefined();
    expect(screen.getByText('Manual')).toBeDefined();
  });

  it('renders Cancel and Create Stack buttons', () => {
    render(<CreateStackDialog {...defaultProps} />);
    expect(screen.getByText('Cancel')).toBeDefined();
    expect(screen.getAllByText('Create Stack').length).toBeGreaterThan(0);
  });

  it('Create Stack button is disabled when name is empty', () => {
    render(<CreateStackDialog {...defaultProps} />);
    const btn = screen.getByRole('button', { name: 'Create Stack' });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('shows error for invalid stack name starting with number', () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: '1invalid' } });
    expect(
      screen.getByText((t) => t.includes('Must start with a letter')),
    ).toBeDefined();
  });

  it('shows error for invalid stack name with spaces', () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'bad name' } });
    expect(
      screen.getByText((t) => t.includes('Must start with a letter')),
    ).toBeDefined();
  });

  it('does not show error for valid stack name', () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'my-stack_1' } });
    expect(screen.queryByText((t) => t.includes('Must start with a letter'))).toBeNull();
  });

  it('Create Stack button enabled for valid name and host', () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'mystack' } });
    const btn = screen.getByRole('button', { name: 'Create Stack' });
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('Create Stack button disabled while isLoading', () => {
    render(<CreateStackDialog {...defaultProps} isLoading={true} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'mystack' } });
    const btn = screen.getByRole('button', { name: 'Create Stack' });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('calls onSubmit with correct data when submitted', () => {
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'mystack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      stackName: 'mystack',
      host: 'server1',
      autoDeploy: false,
    });
  });

  it('calls onSubmit with autoDeploy true when Auto is selected', () => {
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'mystack' } });
    // Click the Auto radio
    const autoRadio = screen.getByDisplayValue('auto');
    fireEvent.click(autoRadio);
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    expect(onSubmit).toHaveBeenCalledWith({
      stackName: 'mystack',
      host: 'server1',
      autoDeploy: true,
    });
  });

  it('calls onSubmit with the newly selected host', async () => {
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);

    // Enter a valid stack name
    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'myapp' } });

    // Open Select and choose server2
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'server2' });
    fireEvent.click(option);

    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    expect(onSubmit).toHaveBeenCalledWith({ stackName: 'myapp', host: 'server2', autoDeploy: false });
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render when open is false', () => {
    render(<CreateStackDialog {...defaultProps} open={false} />);
    expect(screen.queryByLabelText('Stack Name')).toBeNull();
  });

  it('displays error message when error prop is provided', () => {
    render(<CreateStackDialog {...defaultProps} error="Something went wrong" />);
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('does not display error alert when error prop is null', () => {
    render(<CreateStackDialog {...defaultProps} error={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
