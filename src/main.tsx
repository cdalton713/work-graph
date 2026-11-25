import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { SignIn } from "./components/SignIn";
import { configureSite, pageLink } from "./lib/site";
import type { SiteConfig } from "./lib/types";

// The human's name and the default workspace come from the server's config before the first render.
// Without them (an old server), the page uses the defaults of contract.json.
// A page with a sign-in and no session shows only the sign-in screen: the API gives it nothing else.
fetch("/api/config")
  .then((response) => (response.ok ? response.json() : {}))
  .catch(() => ({}))
  .then((config: Partial<SiteConfig>) => {
    configureSite(config);
    pageLink.path = config.link === undefined ? (config.readOnly ? null : "/api/link") : config.link;
    const signIn = !!config.auth && !config.user;
    createRoot(document.getElementById("root")!).render(<StrictMode>{signIn ? <SignIn /> : <App />}</StrictMode>);
  });
