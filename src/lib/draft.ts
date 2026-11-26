type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const fallback = new Map<string, string>();

export function readDraft(storage: DraftStorage | undefined, parts: readonly string[]): string {
  const key = `wg-draft:${JSON.stringify(parts)}`;
  if (fallback.has(key)) return fallback.get(key)!;
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(storage: DraftStorage | undefined, parts: readonly string[], text: string): void {
  const key = `wg-draft:${JSON.stringify(parts)}`;
  if (storage) {
    try {
      if (text) storage.setItem(key, text);
      else storage.removeItem(key);
      fallback.delete(key);
      return;
    } catch {
      // Keep the draft in memory when session storage is unavailable.
    }
  }
  fallback.set(key, text);
}
