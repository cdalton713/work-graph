// WG_PAGE_INTEGRATION=1 pnpm exec vitest run tests/cli-parity/page-node.test.ts
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { expect, it, vi } from "vitest";
import { pgliteSql } from "../../server/testing/pglite.ts";
import { rules, projectFixture } from "../../server/testing/projects.ts";

it.runIf(process.env.WG_PAGE_INTEGRATION === "1")("runs preview commands against the Node page and reconnects after 1012", async () => {
  const db = await pgliteSql();
  const { app, owner, collaborator, viewer } = await projectFixture(db);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  // The fixture listens only on loopback and serves one synthetic hosted tenant.
  const originalHost = rules.hosted.host;
  let authorizedUpgrades = 0;
  server.on("upgrade", req => {
    if (req.headers.authorization === "Bearer " + collaborator.token) authorizedUpgrades++;
  });
  app.injectWebSocket(server);
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    rules.hosted.host = "127.0.0.1:" + address.port;
    const rust = promisify(execFile)("cargo", ["test", "--locked", "--manifest-path", "cli/Cargo.toml",
      "--test", "page", "node_page_commands_and_authorized_reconnect", "--", "--ignored", "--exact", "--nocapture"], {
      env: { ...process.env, WG_TEST_PAGE_URL: "http://127.0.0.1:" + address.port,
        WG_TEST_OWNER: owner.token, WG_TEST_MEMBER: collaborator.token, WG_TEST_VIEWER: viewer.token },
      timeout: 120000,
    });
    const restart = async () => {
      const active = () => app.link.hub.active({ includeGrace: false });
      await vi.waitFor(async () => expect(await active()).toHaveLength(1), { timeout: 115000 });
      app.link.hub.restartSockets();
      await vi.waitFor(async () => {
        expect(authorizedUpgrades).toBe(2);
        expect(await active()).toHaveLength(1);
      });
      await app.link.hub.enqueue((await active())[0], "command", { name: "pause" });
    };
    const [result] = await Promise.all([rust, restart()]);
    expect(result.stdout).toContain("1 passed");
  } finally {
    rules.hosted.host = originalHost;
    app.link.stop();
    server.closeAllConnections();
    server.close();
    await db.close();
    vi.unstubAllGlobals();
  }
}, 125000);
