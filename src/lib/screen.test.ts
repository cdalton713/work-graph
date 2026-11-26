import { afterEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { isStandalone, pullDistance, syncAge, useCoarse, useHover, useNarrow } from "./screen";

vi.mock("react", () => ({ useSyncExternalStore: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["useNarrow", useNarrow, "(max-width: 720px)"],
  ["useCoarse", useCoarse, "(pointer: coarse)"],
  ["useHover", useHover, "(hover: hover)"],
] as const)("%s follows media query changes and unsubscribes", (_name, useQuery, query) => {
  const media = Object.assign(new EventTarget(), { matches: false });
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal("window", { matchMedia });
  const onChange = vi.fn();

  useQuery();
  const [subscribe, snapshot, serverSnapshot] = vi.mocked(useSyncExternalStore).mock.lastCall!;
  expect(serverSnapshot?.()).toBe(false);
  const unsubscribe = subscribe(onChange);
  expect(matchMedia).toHaveBeenCalledWith(query);
  expect(snapshot()).toBe(false);

  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(onChange).toHaveBeenCalledOnce();
  expect(snapshot()).toBe(true);

  unsubscribe();
  media.dispatchEvent(new Event("change"));
  expect(onChange).toHaveBeenCalledOnce();
});

it("returns false and can unsubscribe without matchMedia", () => {
  vi.stubGlobal("window", {});
  useNarrow();
  const [subscribe, snapshot] = vi.mocked(useSyncExternalStore).mock.lastCall!;
  const onChange = vi.fn();

  expect(snapshot()).toBe(false);
  subscribe(onChange)();
  expect(onChange).not.toHaveBeenCalled();
});

describe("installed screens", () => {
  it("detects both forms of standalone mode", () => {
    expect(isStandalone({ matches: true }, {})).toBe(true);
    expect(isStandalone({ matches: false }, { standalone: true })).toBe(true);
    expect(isStandalone({ matches: false }, { standalone: false })).toBe(false);
  });

  it("counts only downward pulls that are more vertical than horizontal", () => {
    expect(pullDistance(12, 100)).toBe(100);
    expect(pullDistance(-100, 12)).toBe(0);
    expect(pullDistance(0, -40)).toBe(0);
  });

  it("shows the age of the last successful sync", () => {
    expect(syncAge(null, 120_000)).toBe("Waiting for first sync");
    expect(syncAge(new Date(0), 120_000)).toBe("Synced 2 min ago");
    expect(syncAge(new Date(0), 20_000)).toBe("Synced just now");
  });
});
