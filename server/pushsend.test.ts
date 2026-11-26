import { expect, test, vi } from "vitest";
import { sendNotice, configRecipient } from "./pushsend.ts";
import { deviceId, defaultSettings, type PushStore } from "./pushstore.ts";

const devices = ["a", "b"].map(id => ({ endpoint: "https://example.com/" + id, keys: { auth: "", p256dh: "" }, label: "", time: 0 }));
const notice = { project: "Project", workspace: "work", projectId: "p", issue: "WG-1", kind: "merge" as const };
const keys = { publicKey: "public", privateKey: "private", subject: "https://example.com" };
function store(): PushStore {
  return { settings: vi.fn(async () => defaultSettings()), list: vi.fn(async () => devices), remove: vi.fn(),
    setSettings: vi.fn(), save: vi.fn() };
}

test("sends generic notices with a stable topic per issue and explicit encryption and signing options", async () => {
  const push = vi.fn(async (..._args: unknown[]) => {});
  await sendNotice(store(), "account", keys, notice, push);
  expect(push).toHaveBeenCalledTimes(2);
  for (const [device, payload, options] of push.mock.calls) {
    expect(devices).toContain(device);
    expect(JSON.parse(String(payload))).toEqual({ title: "A move needs your attention", body: "Project", url: "/?workspace=work&project=p&issue=WG-1" });
    expect(options).toMatchObject({ TTL: 3600, contentEncoding: "aes128gcm", vapidDetails: keys, topic: expect.stringMatching(/^[\w-]{32}$/) });
  }
  expect(push.mock.calls[0][2]).toEqual(push.mock.calls[1][2]);
});

test.each([404, 410])("removes a gone device (%i) and stops retrying it", async statusCode => {
  const storage = store();
  const push = vi.fn().mockRejectedValue({ statusCode });
  await sendNotice(storage, "account", keys, { device: deviceId(devices[0].endpoint) }, push);
  expect(storage.remove).toHaveBeenCalledWith("account", deviceId(devices[0].endpoint));
  expect(push).toHaveBeenCalledTimes(1);
});

test("limits retries and checks settings again before a retry", async () => {
  const storage = store(), push = vi.fn().mockRejectedValue({ statusCode: 503 });
  const testNotice = { device: deviceId(devices[0].endpoint) };
  const delay = vi.fn(async () => {});
  expect(await sendNotice(storage, "acct", keys, testNotice, push, delay)).toBe(3);
  expect(delay).toHaveBeenCalledTimes(2);
  vi.mocked(storage.settings).mockResolvedValueOnce(defaultSettings()).mockResolvedValue({ enabled: false, kinds: [] });
  expect(await sendNotice(storage, "acct", keys, testNotice, push, delay)).toBe(1);
});

test("skips disabled kinds and lets a test reach only its selected device while enabled", async () => {
  const storage = store(), push = vi.fn();
  vi.mocked(storage.settings).mockResolvedValue({ enabled: true, kinds: [] });
  expect(await sendNotice(storage, "acct", keys, notice, push)).toBe(0);
  expect(push).not.toHaveBeenCalled();
  const one = { device: deviceId(devices[1].endpoint) };
  await sendNotice(storage, "acct", keys, one, push);
  expect(push.mock.calls.map(call => call[0])).toEqual([devices[1]]);
  vi.mocked(storage.settings).mockResolvedValue({ enabled: false, kinds: ["merge"] });
  expect(await sendNotice(storage, "acct", keys, one, push)).toBe(0);
  expect(push).toHaveBeenCalledTimes(1);
});

test("selects one configured owner", () => {
  expect(configRecipient(["a"], undefined)).toEqual({ account: "a" });
  expect(configRecipient(["a","b"], undefined)).toMatchObject({ status: 400 });
  expect(configRecipient(["a","b"], "c")).toMatchObject({ status: 403 });
  expect(configRecipient(["a","b"], "b")).toEqual({ account: "b" });
});
