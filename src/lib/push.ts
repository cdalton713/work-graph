import { pushApi } from "../api";
import { isAppleMobile, isStandalone } from "./screen";
import { site } from "./site";

export type NoticeState = "on" | "off" | "denied" | "install" | "unsupported";
const storageKey = () => "wg:push-device:" + site.user;

function capability(): NoticeState {
  if (isAppleMobile() && !isStandalone()) return "install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission === "denied" ? "denied" : "off";
}

async function deviceId(sub: PushSubscription) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function forget(id: string) {
  await pushApi.remove(id);
  localStorage.removeItem(storageKey());
}

export async function readDevice(): Promise<NoticeState> {
  const state = capability();
  const saved = localStorage.getItem(storageKey());
  if (state === "install" || state === "unsupported") return state;
  const reg = Notification.permission === "granted" ? await navigator.serviceWorker.getRegistration("/") : undefined;
  const sub = await reg?.pushManager.getSubscription();
  const id = sub && await deviceId(sub);
  if (saved && saved !== id) await forget(saved);
  if (id && (await pushApi.devices()).devices.some(device => device.id === id)) {
    localStorage.setItem(storageKey(), id);
    return "on";
  }
  return state;
}

export async function enableDevice(): Promise<NoticeState> {
  // Ask before the first await, while the tap still has user activation.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const { publicKey } = await pushApi.key();
  await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  const reg = await navigator.serviceWorker.ready;
  const old = await reg.pushManager.getSubscription();
  // A previous account can still hold this endpoint. Give the new account a fresh one.
  if (old && !await old.unsubscribe()) throw new Error("Could not replace the old subscription.");
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const id = await deviceId(sub);
  localStorage.setItem(storageKey(), id);
  await pushApi.save(sub.toJSON());
  return "on";
}

export async function disableDevice(): Promise<NoticeState> {
  const id = localStorage.getItem(storageKey());
  if (id) await forget(id);
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  return "off";
}

export function testDevice() {
  const id = localStorage.getItem(storageKey());
  if (!id) throw new Error("Turn on notices first.");
  return pushApi.test(id);
}

export function updateBadge(count: number) {
  const operation = count ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
  void operation?.catch(() => {});
}
