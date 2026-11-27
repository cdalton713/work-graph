import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../lib/types";
import { Onboarding } from "./Onboarding";
import { connectUrl, ConnectWorkspace } from "./Settings";

const at = (address: string) => vi.stubGlobal("location", new URL(address, "https://page.example.com"));
const refresh = async () => ({}) as Account;

afterEach(() => { vi.unstubAllGlobals(); });

describe("workspace connection", () => {
  it("returns to the same screen without an earlier result", () => {
    at("/?page=settings&connect=denied");
    expect(connectUrl()).toBe(`/auth/connect?next=${encodeURIComponent("/?page=settings")}`);
    expect(connectUrl("setup")).toBe(`/auth/connect?next=${encodeURIComponent("/?page=setup")}`);
  });

  it.each([
    ["connected", 'role="status"', "Linear connected the workspace."],
    ["denied", 'role="alert"', "the request was canceled"],
  ])("shows the %s result", (result, role, text) => {
    at(`/?page=settings&connect=${result}`);
    const markup = renderToStaticMarkup(<ConnectWorkspace refresh={refresh} oauth />);
    expect(markup).toContain(role);
    expect(markup).toContain(text);
  });

  it.each(["unknown", "constructor", "toString"])("ignores the result value %s", (result) => {
    at(`/?page=settings&connect=${result}`);
    const markup = renderToStaticMarkup(<ConnectWorkspace refresh={refresh} oauth />);
    expect(markup).not.toContain("role=");
    expect(markup).toContain("Connect a workspace with Linear");
  });

  it("offers only the personal API key while OAuth attachment is off", () => {
    at("/?page=settings&connect=connected");
    const inline = renderToStaticMarkup(<ConnectWorkspace refresh={refresh} />);
    expect(inline).not.toContain("Connect a workspace with Linear");
    expect(inline).not.toContain("Linear connected the workspace.");
    expect(inline).toContain("Personal API key");
    const dialog = renderToStaticMarkup(<ConnectWorkspace refresh={refresh} useKey={() => {}} />);
    expect(dialog).toContain("Use a personal API key");
    expect(dialog).not.toContain("Connect a workspace with Linear");
  });

  it("opens the setup guide on the workspaces step after Linear returns", () => {
    at("/?page=setup&connect=denied");
    const account: Account = {
      human: "Ada", pageUrl: "https://page.example.com", tokens: [],
      connections: [{
        id: "first", workspace_id: "example", name: "Example", kind: "oauth", attached: false, status: "ok",
        team: "", team_labels: false, position: 0, owner_name: "Ada", created_at: "",
      }],
      onboarding: { name: false, workspaces: true, teams: false, token: false, connected: false, skipped: false },
      oauthAttach: true,
    };
    const markup = renderToStaticMarkup(<Onboarding account={account} refresh={refresh} overview={() => {}} />);
    expect(markup).toContain("the request was canceled");
    expect(markup).toContain("Connect a workspace with Linear");
  });
});
