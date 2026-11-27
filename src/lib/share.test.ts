import { expect, test } from "vitest";
import { accessNotice, linkRow, orderMembers } from "./share";

test("a live link row keeps its address after the first view", () => {
  const live = { exists: true, createdAt: "2026-01-01", url: "https://example.com/join/kept" } as const;
  expect(linkRow({ exists: false })).toEqual({ state: "missing" });
  expect(linkRow(live)).toEqual({ state: "live", url: "https://example.com/join/kept", made: "2026-01-01" });
  expect(linkRow({ exists: true, createdAt: "2026-01-01" })).toEqual({ state: "live", url: undefined, made: "2026-01-01" });
  expect(linkRow(live, "https://example.com/join/new")).toEqual({
    state: "live", url: "https://example.com/join/new", made: "2026-01-01",
  });
});

test("each missing access result has one action", () => {
  const scope = { workspace: "Example", team: "WG" };
  expect(accessNotice({ ...scope, status: "ok" })).toBeNull();
  expect(accessNotice({ ...scope, status: "no_connection" })).toEqual({
    message: "Connect to the Example Linear workspace.", action: "settings",
  });
  expect(accessNotice({ ...scope, status: "no_team" })).toEqual({
    message: "You need access to team WG in Linear.", action: "request",
  });
  expect(accessNotice({ ...scope, status: "not_member" })).toEqual({
    message: "You need to join the Example Linear workspace.", action: "request",
  });
});

test("collaborators appear before viewers, with earlier members first in each role", () => {
  const viewer = { id: "1", name: "Ada", email: "ada@example.com", role: "viewer", joinedAt: "2026-01-01", accessRequestedAt: null } as const;
  const early = { ...viewer, id: "2", role: "collaborator", joinedAt: "2026-01-02" } as const;
  const late = { ...early, id: "3", joinedAt: "2026-01-03" };
  const members = [viewer, late, early];
  expect(orderMembers(members)).toEqual([early, late, viewer]);
  expect(members).toEqual([viewer, late, early]);
});
