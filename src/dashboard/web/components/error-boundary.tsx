import * as React from "react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  className?: string;
  message?: string;
  resetKey?: string | number | null;
  heading?: string;
}

interface ErrorBoundaryState {
  digest: string | null;
  error: Error | null;
}

function errorDigest(error: Error): string {
  const supplied = (error as Error & { digest?: unknown }).digest;
  if (typeof supplied === "string" && supplied.trim()) return supplied;
  let hash = 0x811c9dc5;
  for (const char of `${error.name}:${error.message}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `render-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class DashboardErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { digest: null, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { digest: errorDigest(error), error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Dashboard render failed", {
      componentStack: info.componentStack,
      digest: this.state.digest,
      error,
    });
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ digest: null, error: null });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <section className={this.props.className ?? "surface-error boundary-error"} role="alert">
      <h2>{this.props.heading ?? "This view couldn't load"}</h2>
      <p>{this.props.message ?? "A rendering error stopped this view. Change the selection or reload the page."}</p>
      <code className="error-digest">Error ID: {this.state.digest}</code>
    </section>;
  }
}
