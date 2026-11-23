import { describe, expect, it } from "vitest";
import { type Status, identity } from "./tailnet.ts";

const status = (over: Status = {}): Status => ({
  BackendState: "Running",
  Self: { DNSName: "Mac.Tail1234.ts.net." },
  CertDomains: ["mac.tail1234.ts.net"],
  ...over,
});

describe("identity", () => {
  it("gives the name of this machine", () => {
    expect(identity(status())).toEqual({ host: "mac.tail1234.ts.net" });
  });
  it("says why the tailnet cannot be used", () => {
    expect(() => identity(status({ BackendState: "Stopped" }))).toThrow("Tailscale is Stopped");
    expect(() => identity(status({ BackendState: "NeedsLogin" }))).toThrow("Tailscale is NeedsLogin");
    expect(() => identity(status({ Self: { DNSName: "" } }))).toThrow("no name");
    expect(() => identity(status({ CertDomains: [] }))).toThrow("HTTPS");
    expect(() => identity(status({ CertDomains: null }))).toThrow("HTTPS");
    expect(() => identity(null)).toThrow("Tailscale");
  });
});
