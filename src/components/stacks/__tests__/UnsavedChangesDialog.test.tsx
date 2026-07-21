import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import UnsavedChangesDialog from '@/components/stacks/UnsavedChangesDialog';

describe('UnsavedChangesDialog', () => {
  it('does not render content when closed', () => {
    render(<UnsavedChangesDialog open={false} onDiscard={() => {}} onKeepEditing={() => {}} />);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('renders title and description when open', () => {
    render(<UnsavedChangesDialog open onDiscard={() => {}} onKeepEditing={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Unsaved changes' })).toBeDefined();
    expect(screen.getByText(/unsaved changes that will be lost/i)).toBeDefined();
  });

  it('calls onDiscard when Discard changes is clicked', () => {
    const onDiscard = mock(() => {});
    render(<UnsavedChangesDialog open onDiscard={onDiscard} onKeepEditing={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('calls onKeepEditing when Keep editing is clicked', () => {
    const onKeepEditing = mock(() => {});
    render(<UnsavedChangesDialog open onDiscard={() => {}} onKeepEditing={onKeepEditing} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
  });
});
