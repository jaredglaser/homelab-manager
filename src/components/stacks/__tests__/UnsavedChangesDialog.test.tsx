import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import UnsavedChangesDialog from '@/components/stacks/UnsavedChangesDialog';

describe('UnsavedChangesDialog', () => {
  it('does not render content when closed', () => {
    render(<UnsavedChangesDialog open={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('renders the default leave-guard copy when open', () => {
    render(<UnsavedChangesDialog open onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Unsaved changes' })).toBeDefined();
    expect(screen.getByText(/unsaved changes that will be lost/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDefined();
  });

  it('renders custom title, description, and labels', () => {
    render(
      <UnsavedChangesDialog
        open
        onConfirm={() => {}}
        onCancel={() => {}}
        title="Deploy with unsaved changes?"
        description="This deploy uses the last saved version."
        confirmLabel="Deploy anyway"
        cancelLabel="Cancel"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Deploy with unsaved changes?' })).toBeDefined();
    expect(screen.getByText('This deploy uses the last saved version.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deploy anyway' })).toBeDefined();
  });

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = mock(() => {});
    render(<UnsavedChangesDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = mock(() => {});
    render(<UnsavedChangesDialog open onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
