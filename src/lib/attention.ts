import { ageText } from "./graph.ts";
import { agentsFresh, type Agents, type Presence } from "./link.ts";
import type { ProjectSummary } from "./overview.ts";

const WORKER_SILENT_MS = 20 * 60_000;
const WORKER_GONE_MS = 3 * 60_000;
const NO_COORDINATOR_MS = 15 * 60_000;

export interface Stall {
  kind: "worker-silent" | "worker-gone" | "no-coordinator" | "no-agent-view";
  reason: string;
  since: string | null;
  issue?: string;
  title?: string;
}

function latest(...values: (string | null | undefined)[]): string | null {
  return values.reduce<string | null>((last, value) =>
    value && Date.parse(value) > (last ? Date.parse(last) : -Infinity) ? value : last, null);
}

function agentLine({ level, text }: { level: string; text: string }): boolean {
  const verb = text.split(" ", 1)[0];
  if (level === "wait") return verb !== "human" && verb !== "owner";
  return level === "do" && !["ask", "ask-ready", "ask-merge"].includes(verb);
}

export function stalls(summary: ProjectSummary, presence: Presence | undefined, agents: Agents | undefined, now: number, readOnly = false): Stall[] {
  const coordinators = presence?.coordinators ?? [];
  if (readOnly || summary.paused || coordinators.some((row) => row.paused)
    || summary.effort?.status === "every ship point is Done or Canceled") return [];

  const jobs = summary.liveJobs ?? [];
  const duties = summary.nextLines?.some((line) => line.level === "do" && agentLine(line));
  const lastReport = agents?.at;
  const fresh = agentsFresh(agents, now);
  const rows = fresh ? agents.agents : [];
  const result: Stall[] = [];

  if (jobs.length && !fresh) {
    result.push({
      kind: "no-agent-view", reason: "No agent view. Worker stalls cannot be seen. Run wg agents --install.",
      since: latest(lastReport) ?? jobs.map((job) => job.startedAt).filter((at): at is string => !!at).sort()[0]
        ?? latest(summary.effort?.at, summary.updatedAt),
    });
  }

  for (const job of fresh ? jobs : []) {
    const workers = rows.filter((row) => row.role === "worker" && row.issue === job.identifier);
    const running = workers.filter((row) => row.state !== "done");
    const since = latest(job.startedAt, ...workers.map((row) => row.at)) ?? latest(summary.effort?.at, summary.updatedAt);
    const elapsed = now - Date.parse(since ?? "");
    const target = { issue: job.identifier, title: job.title, since };
    if (running.length && running.every((row) => row.state === "working") && elapsed >= WORKER_SILENT_MS) {
      result.push({ ...target, kind: "worker-silent", reason: "Worker silent" });
    } else if (!running.length && elapsed >= WORKER_GONE_MS) {
      result.push({ ...target, kind: "worker-gone", reason: "Worker gone" });
    }
  }

  if ((jobs.length || duties) && !coordinators.some((row) => row.connected)
    && !rows.some((row) => row.role === "coordinator" && row.state === "working")) {
    const since = latest(duties ? summary.effort?.at : undefined, ...jobs.map((job) => job.startedAt),
      ...coordinators.map((row) => row.lastSeen), ...rows.filter((row) => row.role === "coordinator").map((row) => row.at))
      ?? latest(summary.effort?.at, summary.updatedAt);
    if (now - Date.parse(since ?? "") >= NO_COORDINATOR_MS) {
      result.push({ kind: "no-coordinator", reason: "No coordinator", since });
    }
  }
  return result;
}

export function nextStep(summary: ProjectSummary, now: number): string | null {
  const line = summary.nextLines?.find(agentLine);
  if (!line) return null;
  const parts = line.text.match(/^(\S+) (\S+) (\S+?)(?:: (.*))?$/);
  if (!parts) return line.level === "do" ? `coordinator: ${line.text}` : line.text;
  const [, verb, , id, detail] = parts;
  const target = id === "-" ? "" : ` ${id}`;
  if (line.level === "do") return `coordinator: ${verb}${target}${detail ? ` · ${detail}` : ""}`;
  if (verb === "worker" || verb === "reviewer") {
    const job = summary.liveJobs?.find((job) => job.identifier === id);
    const age = job && ageText(now - Date.parse(job.startedAt ?? ""))?.replace(/ ago$/, "");
    return `${verb}${target ? ` on${target}` : ""}${age ? ` · ${age}` : ""}`;
  }
  if (verb === "soak" && detail) return `soak ${detail}`;
  if (verb === "paused") return "paused";
  return `${verb}${target}${detail ? ` · ${detail}` : ""}`;
}

export function overviewTitle(inboxCount: number): string {
  return inboxCount ? `(${inboxCount}) Overview` : "Overview";
}
