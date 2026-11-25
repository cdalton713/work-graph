import { describe } from "vitest";
import { memoryLinkState } from "./linkstate.ts";
import { linkStateContract } from "./testing/linkstate-contract.ts";

describe("memory link state", () => linkStateContract(() => {
  const backend = memoryLinkState();
  return { a: { ...backend }, b: { ...backend }, cleanup: () => {} };
}));
