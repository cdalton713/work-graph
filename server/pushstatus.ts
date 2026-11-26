import type { Context } from "hono";
import { linkRefusal, type Rules } from "./access.ts";
import { configRecipient } from "./pushsend.ts";
import type { PushStore } from "./pushstore.ts";
import type { Tenants } from "./tenants.ts";

export function pushStatus(rules: Rules, directory: Tenants, readOnly: boolean, owners: string[] | undefined,
  store?: () => PushStore | Promise<PushStore>) {
  return async (c: Context) => {
    c.header("Cache-Control", "no-store");
    const reason = linkRefusal("coordinator", name => c.req.header(name), rules);
    if (reason || readOnly) return c.json({ error: reason ?? "Read only" }, 403);
    const tenant = await directory.fromToken(c.req.header("authorization"));
    if (!tenant) return c.json({ error: "Coordinator token required" }, 401);
    if (!store) return c.json({ enabled: false, devices: 0 });
    const recipient = c.req.query("recipient");
    if (owners === undefined && recipient !== undefined) return c.json({ error: "The token identifies the recipient" }, 403);
    const account = owners === undefined ? { account: tenant.id } : configRecipient(owners, recipient);
    if ("error" in account) return c.json({ error: account.error }, account.status);
    return c.json({ enabled: true, devices: (await (await store()).list(account.account)).length });
  };
}
