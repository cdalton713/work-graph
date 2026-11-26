import { createECDH } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "./app.ts";
import { filePushStore } from "./pushstore.ts";

test("the coordinator checks the selected owner's device count", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "wg-status-"));
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const owners = ["ada@example.com", "owner@example.com"];
  const host = "page.example.com";
  const linkToken = "a-link-secret-of-at-least-32-characters";
  try {
    await filePushStore(stateDir).save(owners[0], { endpoint: "https://example.com/device", label: "Phone", time: 1,
      keys: { auth: "private", p256dh: "private" } });
    for (const enabled of [false, true]) {
      const app = createApp({ port: 443, tailnet: null, hosted: { host } }, {
        dist: "/unused", team: "WG", readOnly: false, watchMs: 0, linkToken, stateDir,
        auth: { clientId: "client", clientSecret: "secret", secret: linkToken, owners, domains: [] },
        pushEnv: enabled ? { WG_VAPID_PUBLIC_KEY: keys.getPublicKey().toString("base64url"),
          WG_VAPID_SUBJECT: "mailto:push@example.com",
          WG_VAPID_PRIVATE_KEY: keys.getPrivateKey().toString("base64url") } : {},
      });
      const status = (recipient = "", token = linkToken) => app.request("/api/push/status" +
        (recipient ? "?" + new URLSearchParams({ recipient }) : ""), { headers: { host, authorization: "Bearer " + token } });
      try {
        expect((await status("", "wrong")).status).toBe(401);
        if (enabled) {
          expect((await status()).status).toBe(400);
          expect((await status("other@example.com")).status).toBe(403);
          expect(await (await status(owners[1])).json()).toEqual({ enabled, devices: 0 });
        }
        expect(await (await status(owners[0])).json()).toEqual({ enabled, devices: enabled ? 1 : 0 });
      } finally { app.link.stop(); }
    }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
