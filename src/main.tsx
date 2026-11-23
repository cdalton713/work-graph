import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { configureSite } from "./lib/site";

// The human's name and the default workspace come from the server's config before the first render.
// Without them (an old server), the page uses the defaults of contract.json.
fetch("/api/config")
  .then((response) => (response.ok ? response.json() : {}))
  .catch(() => ({}))
  .then((config: { human?: string; defaultWorkspace?: string }) => {
    configureSite(config);
    createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
  });
