import { createHash } from "node:crypto";
import { Agent } from "node:https";
import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
// @ts-expect-error web-push ships JavaScript without declarations.
import { sendNotification } from "web-push";
import type { NoticeSettings } from "../src/lib/types.ts";
import { deviceId, type PushDevice, type PushStore } from "./pushstore.ts";

type Notice = { device: string } | { project: string; projectId: string; workspace: string; issue: string; kind: NoticeSettings["kinds"][number] };
type Vapid = { privateKey: string; publicKey: string; subject: string };
type Transport = (device: PushDevice, payload: string, options: {
  TTL: number; topic: string; contentEncoding: "aes128gcm"; vapidDetails: Vapid; agent: Agent; timeout: number;
}) => Promise<unknown>;

// Subscription endpoints come from the browser. Check the address at connection time, after DNS.
const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0",8], ["10.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8],
  ["169.254.0.0",16], ["172.16.0.0",12], ["192.0.0.0",24], ["192.168.0.0",16], ["198.18.0.0",15],
  ["224.0.0.0",3]] as const) blocked.addSubnet(ip, bits);
blocked.addRange("::", "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ipv6");
blocked.addRange("4000::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("2001::", 32, "ipv6");
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, answers) => {
    if (err) return callback(err, []);
    const addresses = answers.filter(({ address, family }) => !blocked.check(address, family === 4 ? "ipv4" : "ipv6"));
    if (!addresses.length) return callback(new Error("Push requires a public endpoint"), []);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};
const agent = new Agent({ lookup: publicLookup });
const deliver: Transport = (device, payload, options) => {
  const url = new URL(device.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // IP literals bypass the socket DNS lookup.
  if (url.protocol !== "https:" || (isIP(host) && blocked.check(host, isIP(host) === 4 ? "ipv4" : "ipv6"))) {
    throw new Error("Push requires a public HTTPS endpoint");
  }
  return sendNotification(device, payload, options);
};

export async function sendNotice(store: PushStore, account: string, vapidDetails: Vapid, notice: Notice,
  push: Transport = deliver, pause: (ms: number) => Promise<void> = delay): Promise<number> {
  const test = "device" in notice;
  const url = test ? "/" : "/?" + new URLSearchParams({ workspace: notice.workspace, project: notice.projectId, issue: notice.issue });
  const payload = JSON.stringify({ title: "A move needs your attention", body: test ? "" : notice.project, url });
  const topic = createHash("sha256").update(url).digest("base64url").slice(0, 32);
  const devices = await store.list(account);
  let failures = 0;
  await Promise.all(devices.filter(device => !test || deviceId(device.endpoint) === notice.device).map(async device => {
    const id = deviceId(device.endpoint);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        await pause(attempt * 1000);
        if (!(await store.list(account)).some(active => active.endpoint === device.endpoint && active.time === device.time)) return;
      }
      const settings = await store.settings(account);
      if (!settings.enabled || (!test && !settings.kinds.includes(notice.kind))) return;
      try {
        await push(device, payload, { TTL: 3600, topic, contentEncoding: "aes128gcm", vapidDetails, agent, timeout: 5000 });
        return;
      } catch (error) {
        const status = (error as { statusCode?: number } | null)?.statusCode;
        if (status === 410 || status === 404) {
          await store.remove(account, id);
          return;
        }
        failures++;
      }
    }
  }));
  return failures;
}

export function configRecipient(owners: string[], recipient: unknown): { account: string } | { error: string; status: 400 | 403 } {
  if (recipient === undefined && owners.length > 1) return { error: "name a recipient: this installation has several owners", status: 400 };
  const account = recipient === undefined ? owners[0] : recipient;
  if (typeof account !== "string" || !owners.includes(account)) return { error: "Recipient is not an owner", status: 403 };
  return { account };
}
