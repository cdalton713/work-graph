import { useEffect, useState, useSyncExternalStore } from "react";
import { pushApi } from "../api";
import { disableDevice, enableDevice, readDevice, testDevice, type NoticeState } from "../lib/push";
import { site } from "../lib/site";
import { noticeKinds, type NoticeSettings } from "../lib/types";

const states: Record<NoticeState, string> = {
  off: "Off", on: "On", denied: "Refused. Allow notices in system settings.",
  install: "Add this page to the Home Screen first. In Safari, tap Share, then Add to Home Screen.",
  unsupported: "Not possible in this browser.",
};

const labels = { decision: "Decisions and ops steps", merge: "Merge requests", question: "Worker questions", wait: "Other waits" };
const listeners = new Set<() => void>();
let device = { state: null as NoticeState | null, busy: false, message: "" };
function publish(change: Partial<typeof device>) {
  device = { ...device, ...change };
  for (const notify of listeners) notify();
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}
async function run(action: () => Promise<NoticeState | void>, success = "") {
  if (device.busy) return;
  publish({ busy: true, message: "" });
  try { publish({ state: await action() || device.state, message: success }); }
  catch (error) { publish({ message: error instanceof Error ? error.message : "Could not update notices." }); }
  finally { publish({ busy: false }); }
}

export function useNoticeStartup() {
  useEffect(() => { if (site.push) void run(readDevice); }, []);
}

export function Notices({ account = false }: { account?: boolean }) {
  const { state, busy, message } = useSyncExternalStore(subscribe, () => device);
  if (!site.push) return null;
  return <section className={account ? "notices account-card" : "notices"} aria-label="Notice settings">
    {account && <h2>Notices</h2>}
    <label><input type="checkbox" role="switch" checked={state === "on"}
      disabled={busy || (state !== "on" && state !== "off")}
      onChange={() => void run(state === "on" ? disableDevice : enableDevice)} />Notices on this device</label>
    <p>{state ? states[state] : busy ? "Checking notices…" : "Device status unavailable."}</p>
    <button disabled={busy || state !== "on"} onClick={() => void run(async () => { await testDevice(); }, "Test notice requested.")}>Send a test notice</button>
    {message && <p role="status">{message}</p>}
    {!state && !busy && <button onClick={() => void run(readDevice)}>Check again</button>}
    {account && <AccountNotices />}
  </section>;
}

function AccountNotices() {
  const [settings, setSettings] = useState<NoticeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    pushApi.settings().then(value => { if (live) setSettings(value); })
      .catch(() => { if (live) setError("Could not read account notices."); });
    return () => { live = false; };
  }, [retry]);
  async function save(value: NoticeSettings) {
    setBusy(true);
    setError("");
    try { setSettings(await pushApi.setSettings(value)); }
    catch { setError("Could not save account notices."); }
    finally { setBusy(false); }
  }
  return <fieldset disabled={busy}><legend>Account notices</legend>
    {settings && <>
      <label><input type="checkbox" role="switch" checked={settings.enabled}
        onChange={e => void save({ ...settings, enabled: e.target.checked })} />Allow notices on all devices</label>
      {noticeKinds.map(kind => <label key={kind}><input type="checkbox" disabled={!settings.enabled}
        checked={settings.kinds.includes(kind)} onChange={e => void save({ ...settings, kinds: e.target.checked
          ? [...settings.kinds, kind] : settings.kinds.filter(k => k !== kind) })} />{labels[kind]}</label>)}
    </>}
    {error && <p role="alert">{error}</p>}
    {!settings && error && <button onClick={() => { setError(""); setRetry(retry + 1); }}>Retry</button>}
  </fieldset>;
}
