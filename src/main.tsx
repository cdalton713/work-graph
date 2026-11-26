import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { watchStarterSession } from "./lib/starterHandoff";
import { App, ServiceApp } from "./App";
import { SignIn } from "./components/SignIn";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Join } from "./components/Join";
import { configureSite, pageLink } from "./lib/site";
import { signInSettings } from "./lib/site";
import { pageLinkPath } from "./lib/link";
import { configureTelemetry } from "./lib/telemetry";
import type { BrowserSentryConfig } from "./lib/sentry";
import type { SiteConfig } from "./lib/types";

// The human's name and the default workspace come from the server's config before the first render.
// Without them (an old server), the page uses the defaults of contract.json.
// A page with a sign-in and no session shows only the sign-in screen: the API gives it nothing else.
const root = createRoot(document.getElementById("root")!);
type PageConfig = Partial<SiteConfig> & { sentry?: BrowserSentryConfig };

function loadConfig(): Promise<PageConfig> {
  return fetch("/api/config")
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
}

async function loadMonitoring(config: BrowserSentryConfig) {
  try {
    const { startSentry } = await import("./lib/sentry");
    return startSentry(config);
  } catch {
    // Monitoring is optional when the chunk or SDK fails.
    return undefined;
  }
}

const joinPath = location.pathname.startsWith("/join/") ? location.pathname : null;
if (joinPath) {
  const returnedFromSignIn = new URLSearchParams(location.search).get("signed-in") === "1";
  history.replaceState(null, "", "/?join");
  root.render(<StrictMode><Join path={joinPath} returnedFromSignIn={returnedFromSignIn} /></StrictMode>);
  void loadConfig().then(config => {
    if (config.sentry?.dsn) return loadMonitoring(config.sentry);
  });
} else {
  void loadConfig()
    .then(config => {
      configureSite(config);
      if (config.auth) watchStarterSession(config.user ?? null, config.createProjects === true);
      configureTelemetry(config.telemetry === true && !!config.user);
      signInSettings.provider = config.signIn;
      pageLink.path = pageLinkPath(config);
      const signIn = !!config.auth && !config.user;
      const page = signIn ? <SignIn /> : config.signIn === "linear" && config.user && !config.readOnly ? <ServiceApp createProjects={config.createProjects} /> : <App createProjects={config.createProjects} />;
      const monitoring = config.sentry?.dsn ? loadMonitoring(config.sentry) : undefined;
      root.render(<StrictMode>{monitoring
        ? <ErrorBoundary onError={(error, info) => { void monitoring.then(report => report?.(error, info)); }}>
            {page}
          </ErrorBoundary>
        : page}</StrictMode>);
    });
}
