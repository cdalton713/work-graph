import { afterEach, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { useCoarse, useHover, useNarrow } from "./screen";

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
