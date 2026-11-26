import { useSyncExternalStore } from "react";

// Keep these viewport widths in sync with the layouts in styles/tokens.css.
export const PHONE_MAX_WIDTH = 720;
export const TABLET_MIN_WIDTH = PHONE_MAX_WIDTH + 1;
export const DESKTOP_MIN_WIDTH = 1280;

export const TABLET_OR_WIDER = `(min-width: ${TABLET_MIN_WIDTH}px)`;

function mediaQuery(query: string) {
  const getMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : undefined;
  const getSnapshot = () => getMedia()?.matches ?? false;
  const subscribe = (onChange: () => void) => {
    const media = getMedia();
    if (!media) return () => {};
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  };
  return () => useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export const useNarrow = mediaQuery(`(max-width: ${PHONE_MAX_WIDTH}px)`);
export const useCoarse = mediaQuery("(pointer: coarse)");
export const useHover = mediaQuery("(hover: hover)");

type StandaloneNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints"> & { standalone?: boolean };

export function isStandalone(
  display: Pick<MediaQueryList, "matches"> = matchMedia("(display-mode: standalone)"),
  device: { standalone?: boolean } = navigator as StandaloneNavigator,
) {
  return display.matches || device.standalone === true;
}

export function isAppleMobile(device: StandaloneNavigator = navigator) {
  return /iPhone|iPad|iPod/.test(device.userAgent) ||
    (/Macintosh/.test(device.userAgent) && device.maxTouchPoints > 1);
}

export function pullDistance(dx: number, dy: number) {
  return dy > Math.abs(dx) ? dy : 0;
}

export function syncAge(syncedAt: Date | null, now: number) {
  if (!syncedAt) return "Waiting for first sync";
  const minutes = Math.floor((now - syncedAt.getTime()) / 60_000);
  return minutes < 1 ? "Synced just now" : `Synced ${minutes} min ago`;
}
