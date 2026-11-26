import { describe, expect, it } from "vitest";
import { readDraft, writeDraft } from "./draft";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("session drafts", () => {
  it("retains the exact text for a new form and removes it after sending", () => {
    const session = storage();
    writeDraft(session, ["comment", "one"], "  A draft\n");
    expect(readDraft(session, ["comment", "one"])).toBe("  A draft\n");
    writeDraft(session, ["comment", "one"], "");
    expect(readDraft(session, ["comment", "one"])).toBe("");
  });

  it("keeps different issues and forms separate", () => {
    const session = storage();
    writeDraft(session, ["worker", "a:b", "c"], "Reply");
    expect(readDraft(session, ["worker", "a", "b:c"])).toBe("");
    expect(readDraft(session, ["comment", "a:b", "c"])).toBe("");
  });

  it("allows editing in memory when storage is blocked", () => {
    const blocked = () => { throw new Error("Storage is blocked"); };
    const session = { getItem: blocked, setItem: blocked, removeItem: blocked };
    writeDraft(session, ["evidence", "blocked"], "Check passed");
    expect(readDraft(session, ["evidence", "blocked"])).toBe("Check passed");
    writeDraft(session, ["evidence", "blocked"], "");
    expect(readDraft(session, ["evidence", "blocked"])).toBe("");
  });
});
