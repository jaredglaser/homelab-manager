import { describe, it, expect } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import Toasts from '../Toasts';

describe('Toasts', () => {
  it('renders a toast fired through the sonner API', async () => {
    render(<Toasts />);
    toast.error('Something went wrong');
    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeDefined();
    });
  });

  it('renders success toasts', async () => {
    render(<Toasts />);
    toast.success('Saved!');
    await waitFor(() => {
      expect(screen.getByText('Saved!')).toBeDefined();
    });
  });
});
