import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onError(error: unknown, info: ErrorInfo): void;
}

export class ErrorBoundary extends Component<Props> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError(error, info);
  }

  render() {
    if (this.state.failed) return <p role="alert">The page could not load. Reload the page to try again.</p>;
    return this.props.children;
  }
}
