import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider, useSetAtom } from 'jotai';
import { createElement, useEffect } from 'react';
import Toasts from '../Toasts';
import { toastsAtom } from '@/hooks/toastAtom';

function createWrapper(initialToasts: { id: number; message: string; severity: 'error' | 'warning' | 'info' | 'success' }[]) {
  return ({ children }: { children: React.ReactNode }) => {
    function Seeder() {
      const setToasts = useSetAtom(toastsAtom);
      useEffect(() => {
        setToasts(initialToasts);
      }, [setToasts]);
      return null;
    }
    return createElement(Provider, null, createElement(Seeder), children);
  };
}

describe('Toasts', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(
      createElement(Provider, null, createElement(Toasts))
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the first toast message', () => {
    const wrapper = createWrapper([{ id: 1, message: 'Something went wrong', severity: 'error' }]);
    render(<Toasts />, { wrapper });
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('renders an error severity alert', () => {
    const wrapper = createWrapper([{ id: 1, message: 'Error toast', severity: 'error' }]);
    render(<Toasts />, { wrapper });
    const alert = screen.getByRole('alert');
    expect(alert).toBeDefined();
  });

  it('renders a success severity alert', () => {
    const wrapper = createWrapper([{ id: 2, message: 'Saved!', severity: 'success' }]);
    render(<Toasts />, { wrapper });
    expect(screen.getByText('Saved!')).toBeDefined();
  });

  it('renders a warning severity alert', () => {
    const wrapper = createWrapper([{ id: 3, message: 'Watch out', severity: 'warning' }]);
    render(<Toasts />, { wrapper });
    expect(screen.getByText('Watch out')).toBeDefined();
  });

  it('renders an info severity alert', () => {
    const wrapper = createWrapper([{ id: 4, message: 'FYI', severity: 'info' }]);
    render(<Toasts />, { wrapper });
    expect(screen.getByText('FYI')).toBeDefined();
  });

  it('shows only the first toast when multiple toasts are queued', () => {
    const wrapper = createWrapper([
      { id: 1, message: 'First toast', severity: 'error' },
      { id: 2, message: 'Second toast', severity: 'info' },
    ]);
    render(<Toasts />, { wrapper });
    expect(screen.getByText('First toast')).toBeDefined();
    expect(screen.queryByText('Second toast')).toBeNull();
  });

  it('dismisses the toast when the Alert close button is clicked', () => {
    const wrapper = createWrapper([{ id: 1, message: 'Dismiss me', severity: 'error' }]);
    render(<Toasts />, { wrapper });
    const closeButtons = screen.getAllByRole('button');
    fireEvent.click(closeButtons[0]);
  });
});
