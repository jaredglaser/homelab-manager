import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';

/** Component that throws when `shouldThrow` is true */
function ThrowingChild({ shouldThrow, message = 'Test error' }: { shouldThrow: boolean; message?: string }) {
  if (shouldThrow) throw new Error(message);
  return <div>Child content</div>;
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Suppress console.error output during tests that expect errors
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Child content')).toBeTruthy();
  });

  it('renders default fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow message="Something broke" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('Something broke')).toBeTruthy();
  });

  it('renders custom fallback when provided and a child throws', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingChild shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Custom fallback')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('shows "Unknown error" when error has no message', () => {
    function ThrowNoMessage(): React.ReactNode {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { message: undefined };
    }
    render(
      <ErrorBoundary>
        <ThrowNoMessage />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Unknown error')).toBeTruthy();
  });

  it('calls console.error with boundary name when name prop is provided', () => {
    render(
      <ErrorBoundary name="my-boundary">
        <ThrowingChild shouldThrow message="Named boundary error" />
      </ErrorBoundary>,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
    const calls = consoleErrorSpy.mock.calls;
    const boundaryCall = calls.find((c: unknown[]) => typeof c[0] === 'string' && c[0].includes('[ErrorBoundary:my-boundary]'));
    expect(boundaryCall).toBeTruthy();
  });

  it('calls console.error without name when name prop is omitted', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow message="Unnamed boundary error" />
      </ErrorBoundary>,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
    const calls = consoleErrorSpy.mock.calls;
    const boundaryCall = calls.find((c: unknown[]) => typeof c[0] === 'string' && c[0] === '[ErrorBoundary]');
    expect(boundaryCall).toBeTruthy();
  });

  it('does not render children after catching an error', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('Child content')).toBeNull();
  });

  it('clicking "Try again" calls onReset and clears the error state', () => {
    const onReset = mock(() => {});

    function Wrapper() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <ErrorBoundary onReset={() => { onReset(); setShouldThrow(false); }}>
          <ThrowingChild shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }

    render(<Wrapper />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    fireEvent.click(screen.getByText('Try again'));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Child content')).toBeTruthy();
  });

  it('render-prop fallback receives a working reset callback', () => {
    const onReset = mock(() => {});

    function Wrapper() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <ErrorBoundary
          onReset={() => { onReset(); setShouldThrow(false); }}
          fallback={(reset) => (
            <button type="button" onClick={reset} data-testid="custom-reset">
              Reset
            </button>
          )}
        >
          <ThrowingChild shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }

    render(<Wrapper />);
    fireEvent.click(screen.getByTestId('custom-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Child content')).toBeTruthy();
  });
});
