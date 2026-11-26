import { defineConfig } from "@playwright/test";
import { pageUrl, servicePort, serviceUrl } from "./e2e/support/ports.ts";

const sizes = [
  ["phone", 320, 568], ["phone", 390, 844], ["phone", 430, 932],
  ["tablet", 820, 1180], ["tablet", 1180, 820], ["desktop", 1440, 900],
] as const;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  use: { browserName: "chromium", baseURL: pageUrl, screenshot: "only-on-failure", serviceWorkers: "block" },
  projects: sizes.map(([device, width, height]) => ({
    name: `${device}-${width}x${height}`,
    use: { viewport: { width, height }, hasTouch: device !== "desktop", isMobile: device === "phone" },
  })),
  webServer: [
    { command: "node e2e/support/page-server.ts", url: `${pageUrl}/healthz`,
      env: { WG_STATE_DIR: "" }, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    { command: `node server/testing/service-dev.ts --port ${servicePort}`, url: `${serviceUrl}/healthz`,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
  ],
});
