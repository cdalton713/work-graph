// What the page says about the health of the server: a stale graph, a low Linear budget, and the build.
import { ageText } from "./graph";
import type { GraphData, ServerStatus } from "./types";

/** Below this count of remaining Linear requests, the overview warns. The key gives 5,000 each hour. */
export const LOW_BUDGET = 500;

/**
 * The banner of a stale graph: the server could not refresh it from Linear, so it sent its last graph.
 * Null for a fresh graph. Without `loadedAt` (an older server), the banner gives no age.
 */
export function staleBanner(graph: Pick<GraphData, "stale" | "error" | "loadedAt"> | null, now: number): { text: string; title: string } | null {
  if (!graph?.stale) return null;
  const age = graph.loadedAt === undefined ? null : ageText(now - graph.loadedAt);
  const from = age === null ? "from an earlier load" : `from ${age === "now" ? "less than 1 min ago" : age}`;
  return {
    text: `Linear is unavailable: this graph is ${from}`,
    title: `The server could not refresh the graph from Linear${graph.error ? ` (${graph.error})` : ""}. The page shows the last graph and refreshes again at the next poll.`,
  };
}

/** The workspaces whose last Linear answer gave fewer than `LOW_BUDGET` remaining requests. */
export function budgetWarnings(status: ServerStatus | null, now: number): { id: string; text: string; title: string }[] {
  return (status?.workspaces ?? [])
    .filter((w) => w.requestsRemaining !== null && w.requestsRemaining < LOW_BUDGET)
    .map((w) => {
      const reset = w.requestsReset === null ? null : Math.max(0, Math.ceil((w.requestsReset - now) / 60_000));
      return {
        id: w.id,
        text: `${w.name}: ${w.requestsRemaining} Linear requests left${reset === null ? "" : ` · resets in ${reset} min`}`,
        title: `The Linear key of ${w.name} has ${w.requestsRemaining}${w.requestsLimit === null ? "" : ` of ${w.requestsLimit}`} requests left this hour. The page, wg, and the workers share it.`,
      };
    });
}

/** The build of the server for the top bar: a commit shows its first 7 characters. Null before the first status. */
export function versionText(status: Pick<ServerStatus, "version"> | null): string | null {
  if (!status?.version) return null;
  return /^[0-9a-f]{40}$/i.test(status.version) ? status.version.slice(0, 7) : status.version;
}

/** The graph version that the page holds for a project (`workspace:id`), and whether that graph was stale. */
export interface HeldGraph { project: string; value: string; stale?: boolean }

/**
 * One poll of the graph. The page sends the version it holds (`have`), so the server can answer 204 for no
 * change, except while its graph is stale: a fresh graph with the same version must replace the stale one, or
 * the banner stays. `next` is the new graph, or null for no change.
 */
export async function pollGraph<T extends { version: string; stale?: boolean }>(held: HeldGraph | null, project: string,
  fetchGraph: (have?: string) => Promise<T | null>): Promise<{ held: HeldGraph | null; next: T | null }> {
  const have = held?.project === project && !held.stale ? held.value : undefined;
  const next = await fetchGraph(have);
  return next ? { held: { project, value: next.version, stale: next.stale }, next } : { held, next: null };
}
