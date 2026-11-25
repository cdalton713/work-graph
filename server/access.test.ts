import { describe, expect, it } from "vitest";
import { type Rules, refusal as refuse } from "./access.ts";

const HOST = "mac.tail1234.ts.net";
const rules: Rules = { port: 4747, tailnet: { host: HOST } };
type Head = Record<string, string>;
const get = (headers: Head, r: Rules = rules) => refuse("GET", (name) => headers[name], r);
const write = (headers: Head, method = "PATCH", r: Rules = rules) =>
  refuse(method, (name) => ({ "content-type": "application/json", ...headers })[name], r);

describe("refusal", () => {
  it("lets this machine read under its two local names", () => {
    expect(refuse("HEAD", (name) => ({ host: "127.0.0.1:4747" } as Head)[name], rules)).toBeNull();
    expect(get({ host: "127.0.0.1:4747" })).toBeNull();
    expect(get({ host: "localhost:4747" })).toBeNull();
  });
  it("refuses a host that is not this page, also the local names on another port", () => {
    expect(get({ host: "evil.example:4747" })).toBe("bad host");
    expect(get({ host: "127.0.0.1:9999" })).toBe("bad host");
    expect(get({ host: "127.0.0.1" })).toBe("bad host");
    expect(get({})).toBe("bad host");
  });
  it("lets a write pass only from the page of the same host, as JSON", () => {
    expect(write({ host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747" })).toBeNull();
    expect(write({ host: "localhost:4747", origin: "http://localhost:4747" }, "POST")).toBeNull();
    expect(write({ host: "127.0.0.1:4747", origin: "http://evil.example" })).toBe("bad origin");
    expect(write({ host: "127.0.0.1:4747", origin: `https://${HOST}` })).toBe("bad origin");
    expect(write({ host: "127.0.0.1:4747" })).toBe("bad origin");
    expect(write({ host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747", "content-type": "text/plain" })).toBe("bad origin");
  });
  it("accepts the tailnet name while Serve runs, but not a request from the internet", () => {
    expect(get({ host: HOST })).toBeNull();
    expect(get({ host: HOST.toUpperCase() })).toBeNull();
    expect(write({ host: HOST, origin: `https://${HOST}` })).toBeNull();
    expect(write({ host: HOST, origin: `http://${HOST}` })).toBe("bad origin");
    expect(get({ host: HOST, "tailscale-funnel-request": "?1" })).toBe("a request from the internet may not use this page");
    expect(get({ host: `${HOST}:443` })).toBe("bad host");
    expect(get({ host: HOST }, { port: 4747, tailnet: null })).toBe("bad host");
  });
  it("answers on the hosted page under its name only", () => {
    const hosted: Rules = { port: 4747, tailnet: null, hosted: { host: "wg.example.com" } };
    expect(get({ host: "wg.example.com" }, hosted)).toBeNull();
    expect(write({ host: "WG.example.com", origin: "https://wg.example.com" }, "PATCH", hosted)).toBeNull();
    expect(write({ host: "wg.example.com", origin: "http://wg.example.com" }, "PATCH", hosted)).toBe("bad origin");
    expect(get({ host: "127.0.0.1:4747" }, hosted)).toBe("bad host");
  });
});
