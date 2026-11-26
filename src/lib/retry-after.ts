// Retry-After is a number of seconds or an HTTP date. Use a short fixed wait
// when a rate-limit response has no usable deadline.
export function retryDeadline(header: string | null, now: number, fallbackMs = 30_000): number {
  const text = header?.trim() ?? "";
  const deadline = /^\d+$/.test(text) ? now + Number(text) * 1000
    : /[a-z]/i.test(text) ? Date.parse(text) : NaN;
  return Number.isSafeInteger(deadline) ? Math.max(now, deadline) : now + fallbackMs;
}
