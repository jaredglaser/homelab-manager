import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Optional label for identifying which boundary caught the error */
  name?: string;
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

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex items-center justify-center p-4 text-[var(--mui-palette-text-secondary)]">
          <div className="text-center">
            <p className="text-sm font-medium mb-1">Something went wrong</p>
            <p className="text-xs opacity-70">{this.state.error?.message || 'Unknown error'}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
