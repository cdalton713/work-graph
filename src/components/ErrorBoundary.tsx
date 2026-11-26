import { ErrorBoundary as SentryErrorBoundary } from "@sentry/react";
import type { ReactNode } from "react";

export function ErrorBoundary({ children }: { children: ReactNode }) {
  return <SentryErrorBoundary fallback={<p role="alert">The page could not load. Reload the page to try again.</p>}>
    {children}
  </SentryErrorBoundary>;
}
