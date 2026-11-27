import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupUser } from '@/lib/test/user-event';
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

  it('shows error for invalid stack name starting with number', async () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: '1invalid' } });
    fireEvent.blur(input);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Start with a letter, then use only letters, numbers, hyphens and underscores.',
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Create Stack' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows error for invalid stack name with spaces', async () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'bad name' } });
    fireEvent.blur(input);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Start with a letter, then use only letters, numbers, hyphens and underscores.',
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Create Stack' }).hasAttribute('disabled')).toBe(true);
  });

  it('does not show error for valid stack name', () => {
    render(<CreateStackDialog {...defaultProps} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'my-stack_1' } });
    expect(screen.queryByText((t) => t.includes('Start with a letter'))).toBeNull();
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

  it('calls onSubmit with correct data when submitted', async () => {
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'mystack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      stackName: 'mystack',
      host: 'server1',
      autoDeploy: false,
    });
  });

  it('calls onSubmit with autoDeploy true when Auto is selected', async () => {
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Stack Name');
    fireEvent.change(input, { target: { value: 'mystack' } });
    // Click the Auto radio
    const autoRadio = screen.getByDisplayValue('auto');
    fireEvent.click(autoRadio);
    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      stackName: 'mystack',
      host: 'server1',
      autoDeploy: true,
    }));
  });

  it('calls onSubmit with the newly selected host', async () => {
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);

    // Enter a valid stack name
    fireEvent.change(screen.getByLabelText('Stack Name'), { target: { value: 'myapp' } });

    // Open Select and choose server2
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'server2' });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);

    fireEvent.click(screen.getByRole('button', { name: 'Create Stack' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ stackName: 'myapp', host: 'server2', autoDeploy: false }));
  });

  it('asks for a name when the field is left empty', async () => {
    const user = setupUser();
    render(<CreateStackDialog {...defaultProps} />);
    await user.click(screen.getByLabelText('Stack Name'));
    await user.tab();
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name for this stack.');
  });

  it('sends nothing for an invalid name', async () => {
    const user = setupUser();
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Stack Name'), 'bad name');
    await user.tab();
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Create Stack' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says beside the button that a name is needed until the field is left', async () => {
    const user = setupUser();
    render(<CreateStackDialog {...defaultProps} />);
    const footer = screen.getByRole('button', { name: 'Create Stack' }).parentElement;
    expect(footer?.textContent).toContain('Enter a name for this stack.');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByLabelText('Stack Name'));
    await user.tab();
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name for this stack.');
    expect(footer?.textContent).not.toContain('Enter a name for this stack.');
  });

  it('asks for a target host when there is none to pick', async () => {
    const user = setupUser();
    render(<CreateStackDialog {...defaultProps} hosts={[]} />);
    await user.type(screen.getByLabelText('Stack Name'), 'my-app');
    const footer = screen.getByRole('button', { name: 'Create Stack' }).parentElement;
    expect(footer?.textContent).toContain('Select a target host.');
    expect(screen.getByRole('button', { name: 'Create Stack' }).hasAttribute('disabled')).toBe(true);
  });

  it('sends the name without the spaces around it', async () => {
    const user = setupUser();
    const onSubmit = mock(() => {});
    render(<CreateStackDialog {...defaultProps} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Stack Name'), '  my-app ');
    await user.click(screen.getByRole('button', { name: 'Create Stack' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ stackName: 'my-app', host: 'server1', autoDeploy: false }));
  });

  it('puts a name the server says is taken under the name field', async () => {
    const user = setupUser();
    const view = render(<CreateStackDialog {...defaultProps} />);
    await user.type(screen.getByLabelText('Stack Name'), 'my-app');
    view.rerender(<CreateStackDialog {...defaultProps} error={{ message: 'A stack with this name already exists. Choose another name.', field: 'stackName' }} />);
    expect((await screen.findByRole('alert')).textContent).toBe('A stack with this name already exists. Choose another name.');
    expect(screen.getByLabelText('Stack Name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Create Stack' }).hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('Stack Name'), '2');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: 'Create Stack' }).hasAttribute('disabled')).toBe(false);
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
    render(<CreateStackDialog {...defaultProps} error={{ message: 'Something went wrong', field: null }} />);
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('does not display error alert when error prop is null', () => {
    render(<CreateStackDialog {...defaultProps} error={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays open on Escape while the stack is being created', async () => {
    const user = setupUser();
    const onClose = mock(() => undefined);
    render(<CreateStackDialog {...defaultProps} isLoading={true} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Create Stack' }).hasAttribute('disabled')).toBe(true);
  });
});
