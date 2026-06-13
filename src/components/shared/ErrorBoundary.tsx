import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Static fallback node, or a render-prop that receives the reset callback */
  fallback?: ReactNode | ((reset: () => void) => ReactNode);
  /** Optional label for identifying which boundary caught the error */
  name?: string;
  /** Called when the boundary resets; use for external state cleanup */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}]`, error, errorInfo);
  }

  resetErrorBoundary(): void {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        const { fallback } = this.props;
        return typeof fallback === 'function'
          ? fallback(() => this.resetErrorBoundary())
          : fallback;
      }
      return (
        <div className="flex items-center justify-center p-4 text-muted-foreground">
          <div className="text-center">
            <p className="text-sm font-medium mb-1">Something went wrong</p>
            <p className="text-xs opacity-70">{this.state.error?.message || 'Unknown error'}</p>
            <button
              type="button"
              className="mt-2 text-xs underline opacity-70 hover:opacity-100"
              onClick={() => this.resetErrorBoundary()}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
