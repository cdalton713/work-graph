import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App, ServiceApp } from "./App";
import { SignIn } from "./components/SignIn";
import { Join } from "./components/Join";
import { configureSite, pageLink } from "./lib/site";
import { signInSettings } from "./lib/site";
import { pageLinkPath } from "./lib/link";
import { configureTelemetry } from "./lib/telemetry";
import type { SiteConfig } from "./lib/types";

// The human's name and the default workspace come from the server's config before the first render.
// Without them (an old server), the page uses the defaults of contract.json.
// A page with a sign-in and no session shows only the sign-in screen: the API gives it nothing else.
const root = createRoot(document.getElementById("root")!);
const joinPath = location.pathname.startsWith("/join/") ? location.pathname : null;
if (joinPath) {
  history.replaceState(null, "", "/?join");
  root.render(<StrictMode><Join path={joinPath} /></StrictMode>);
} else {
  fetch("/api/config")
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}))
    .then((config: Partial<SiteConfig>) => {
      configureSite(config);
      configureTelemetry(config.telemetry === true && !!config.user);
      signInSettings.provider = config.signIn;
      pageLink.path = pageLinkPath(config);
      const signIn = !!config.auth && !config.user;
      const page = signIn ? <SignIn /> : config.signIn === "linear" && config.user && !config.readOnly ? <ServiceApp /> : <App />;
      root.render(<StrictMode>{page}</StrictMode>);
    });
}
