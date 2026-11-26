import { afterEach, expect, it, vi } from "vitest";
import { configureTelemetry, pageEvent, setUsageConsent } from "./telemetry.ts";

afterEach(() => {
  configureTelemetry(false);
  setUsageConsent(true);
  vi.unstubAllGlobals();
});

it("sends only the event and workspace with keepalive after the server enables usage data", () => {
  const request = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", request);
  pageEvent("node_opened", "work");
  expect(request).not.toHaveBeenCalled();
  configureTelemetry(true);
  pageEvent("node_opened", "work");
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/events", {
    method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "node_opened", workspace: "work" }),
  });
  setUsageConsent(false);
  pageEvent("node_opened", "work");
  expect(request).toHaveBeenCalledTimes(1);
});
