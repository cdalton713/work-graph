import { describe, expect, it } from "vitest";
import { LOW_BUDGET, budgetWarnings, staleBanner, versionText } from "./health";
import type { ServerStatus } from "./types";

const now = Date.parse("2026-11-20T12:00:00Z");
const status = (workspaces: Partial<ServerStatus["workspaces"][number]>[], version = "dev"): ServerStatus => ({
  version, contract: null, uptime: 1, cache: 0, rooms: [],
  workspaces: workspaces.map((w) => ({ id: "w", name: "Work", requestsRemaining: null, requestsLimit: null, requestsReset: null,
    complexityRemaining: null, complexityReset: null, at: null, ...w })),
});

describe("staleBanner", () => {
  it("shows nothing for a fresh graph", () => {
    expect(staleBanner(null, now)).toBeNull();
    expect(staleBanner({}, now)).toBeNull();
    expect(staleBanner({ stale: false }, now)).toBeNull();
  });
  it("gives the age of a stale graph and the error", () => {
    const banner = staleBanner({ stale: true, error: "Linear: HTTP 500", loadedAt: now - 6 * 60_000 }, now);
    expect(banner?.text).toBe("Linear is unavailable: this graph is from 6 min ago");
    expect(banner?.title).toContain("Linear: HTTP 500");
    expect(staleBanner({ stale: true, loadedAt: now - 10_000 }, now)?.text).toBe("Linear is unavailable: this graph is from less than 1 min ago");
  });
  it("gives no age when the server sends no load time", () => {
    expect(staleBanner({ stale: true }, now)?.text).toBe("Linear is unavailable: this graph is from an earlier load");
  });
});

describe("budgetWarnings", () => {
  it("warns only for a workspace below the limit", () => {
    expect(budgetWarnings(null, now)).toEqual([]);
    expect(budgetWarnings(status([{ requestsRemaining: null }, { id: "b", requestsRemaining: LOW_BUDGET }]), now)).toEqual([]);
    const [warning, ...rest] = budgetWarnings(status([{ requestsRemaining: 120, requestsLimit: 5000, requestsReset: now + 14 * 60_000 }, { id: "b", requestsRemaining: 4000 }]), now);
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({ id: "w", text: "Work: 120 Linear requests left · resets in 14 min" });
    expect(warning.title).toContain("120 of 5000");
  });
  it("leaves out the reset when Linear sent none", () => {
    expect(budgetWarnings(status([{ requestsRemaining: 0 }]), now)[0].text).toBe("Work: 0 Linear requests left");
  });
});

describe("versionText", () => {
  it("shortens a commit and keeps another name", () => {
    expect(versionText(null)).toBeNull();
    expect(versionText({ version: "ac8ba2c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6" })).toBe("ac8ba2c");
    expect(versionText({ version: "dev" })).toBe("dev");
  });
});
