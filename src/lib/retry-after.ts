// Retry-After is a number of seconds or an HTTP date. Use a short fixed wait
// when a rate-limit response has no usable deadline.
export function retryDeadline(header: string | null, now: number, fallbackMs = 30_000): number {
  const text = header?.trim() ?? "";
  const deadline = /^\d+$/.test(text) ? now + Number(text) * 1000
    : /[a-z]/i.test(text) ? Date.parse(text) : NaN;
  return Number.isSafeInteger(deadline) ? Math.max(now, deadline) : now + fallbackMs;
}

// Only directory GETs use this header. Each value is a percent-encoded workspace ID.
export const omitWorkspacesHeader = "x-omit-workspaces";
export const maxOmittedWorkspaces = 32;
export const maxEncodedWorkspaceLength = 128;

export function omittedWorkspaces(header?: string): Set<string> {
  const ids = new Set<string>();
  if (!header || header.length > maxOmittedWorkspaces * (maxEncodedWorkspaceLength + 1)) return ids;
  for (const value of header.split(",").slice(0, maxOmittedWorkspaces)) {
    if (value && value.length <= maxEncodedWorkspaceLength) {
      try { ids.add(decodeURIComponent(value)); } catch { /* Ignore a malformed ID. */ }
    }
  }
  return ids;
}
