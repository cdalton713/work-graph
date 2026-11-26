import { defineConfig } from "@playwright/test";

const sizes = [
  ["phone", 320, 568], ["phone", 390, 844], ["phone", 430, 932],
  ["tablet", 820, 1180], ["tablet", 1180, 820], ["desktop", 1440, 900],
] as const;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.GITHUB_ACTIONS
    ? [["dot"], ["json", { outputFile: "test-results/report.json" }]]
    : undefined,
  forbidOnly: !!process.env.CI,
  use: { browserName: "chromium", screenshot: "only-on-failure", serviceWorkers: "block" },
  projects: sizes.map(([device, width, height]) => ({
    name: `${device}-${width}x${height}`,
    use: { viewport: { width, height }, hasTouch: device !== "desktop", isMobile: device === "phone" },
  })),
  webServer: [
    { command: "node e2e/support/page-server.ts", wait: { stdout: /Page fixture at (?<wg_e2e_page_url>http:\/\/127\.0\.0\.1:\d+)\// },
      env: { WG_STATE_DIR: "" }, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    { command: "node server/testing/service-dev.ts --port 0",
      wait: { stdout: /Service preview at (?<wg_e2e_service_url>http:\/\/127\.0\.0\.1:\d+)\// },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
  ],
});
