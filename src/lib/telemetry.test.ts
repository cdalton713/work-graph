import { afterEach, expect, it, vi } from "vitest";
import { configureTelemetry, pageEvent, pageEvents, setUsageConsent } from "./telemetry.ts";

afterEach(() => {
  configureTelemetry(false);
  setUsageConsent(true);
  vi.unstubAllGlobals();
});

it.each(["node_opened", "share_dialog_opened"] as const)("sends only the %s event and workspace when usage data is on", (event) => {
  const request = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", request);
  pageEvent(event, "work");
  expect(request).not.toHaveBeenCalled();
  configureTelemetry(true);
  pageEvent(event, "work");
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/events", {
    method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, workspace: "work" }),
  });
  setUsageConsent(false);
  pageEvent(event, "work");
  expect(request).toHaveBeenCalledTimes(1);
});

it("allows the share dialog open event through the page event table", () => {
  expect(pageEvents.share_dialog_opened).toEqual({ event: "share_dialog_opened", fields: {} });
});
