import { describe } from "vitest";
import { memoryLinkBus } from "./linkbus.ts";
import { linkBusContract } from "./testing/linkbus-contract.ts";

describe("memory link bus", () => linkBusContract(() => {
  const backend = memoryLinkBus();
  return { a: { ...backend }, b: { ...backend }, cleanup: () => {} };
}));
