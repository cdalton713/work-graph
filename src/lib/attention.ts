import { ageText, rankMoves } from "./graph.ts";
import { agentsFresh, presenceText, type Agents, type Presence } from "./link.ts";
import type { ProjectSummary } from "./overview.ts";
import type { Project } from "./types.ts";
import { overviewMoveReason } from "./words.ts";

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
  // A project message confirms that this page receives link data for the room.
  if (readOnly || (!presence && !agents)) return [];
  const coordinators = presence?.coordinators ?? [];
  if (summary.paused || coordinators.some((row) => row.paused)
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
  const triage = line.level === "do" && line.text.match(/^triage (\S+): (.*)$/);
  if (triage) return `coordinator: triage ${triage[1]} · ${triage[2]}`;
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
  if (verb === "soak" && detail) {
    const until = new Date(detail.startsWith("until ") ? detail.slice(6) : "");
    if (Number.isFinite(until.getTime())) {
      return `soak until ${until.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
    }
    return `soak ${detail}`;
  }
  if (verb === "paused") return "paused";
  return `${verb}${target}${detail ? ` · ${detail}` : ""}`;
}

export const PROJECT_STATES = ["stalled", "waits", "moving", "idle"] as const;
export type ProjectStateName = (typeof PROJECT_STATES)[number];
export interface ProjectState { state: ProjectStateName; reason: string }

interface ProjectActivity {
  now: number;
  project?: Pick<Project, "paused" | "statusType">;
  presence?: Presence;
  agents?: Agents;
  stalls?: Stall[];
}

export function projectState(summary: ProjectSummary | null, activity: ProjectActivity): ProjectState {
  const { now, project, presence, agents } = activity;
  const paused = project?.paused || project?.statusType === "paused" || summary?.paused
    || presence?.coordinators.some((row) => row.paused);
  const complete = project?.statusType === "completed" || project?.statusType === "canceled"
    || summary?.effort?.status === "every ship point is Done or Canceled";
  const stall = summary && !paused && !complete && (activity.stalls ?? stalls(summary, presence, agents, now))[0];
  if (stall) {
    const age = stall.since ? ageText(now - Date.parse(stall.since)) : null;
    return { state: "stalled", reason: [stall.issue, stall.reason, age].filter(Boolean).join(" · ") };
  }

  if (summary?.you.length) {
    const [{ move }] = rankMoves(summary.you.map((move) => ({ move })));
    const reason = [move.identifier, overviewMoveReason(move.why).replace(/:\s*$/, ""), move.title]
      .filter((part, index, parts) => part && (index !== 2 || !parts[1].includes(part))).join(" · ");
    const others = summary.you.length - 1;
    return { state: "waits", reason: others ? `${reason} +${others}` : reason };
  }

  const idle = (reason: string): ProjectState => ({ state: "idle", reason });
  if (paused) return idle("Paused");
  if (project?.statusType === "canceled") return idle("Canceled");
  if (complete) return idle("Each node is done");
  if (summary?.error) return idle(summary.error);
  if (!summary) return idle("Project details are loading");

  const hasDuty = summary.nextLines?.some((line) => line.level === "do" && agentLine(line));
  const mode = presenceText(presence, now, agents)?.state;
  const coordinatorWorks = mode === "working" || mode === "listening"
    || (agentsFresh(agents, now) && agents.agents.some((row) => row.role === "coordinator" && row.state === "working"));
  const job = summary.liveJobs?.[0];
  if (job || (hasDuty && coordinatorWorks)) {
    return { state: "moving", reason: nextStep(summary, now) ?? (job ? `Worker on ${job.identifier}` : "Coordinator working") };
  }

  if (summary.planned > 0 && summary.done === summary.planned) return idle("Each node is done");
  const soak = summary.nextLines?.find(({ level, text }) => level === "wait" && text.startsWith("soak "));
  if (soak) return idle(nextStep({ ...summary, nextLines: [soak] }, now) ?? soak.text);
  if (summary.externalBlocker) return idle(`Waits for ${summary.externalBlocker} outside the project`);
  const collaborator = summary.nextLines?.find(({ level, text }) => level === "wait" && /^(collaborator|owner) /.test(text));
  if (collaborator?.text.startsWith("owner ")) return idle("Waits for the owner");
  const holder = collaborator?.text.match(/^collaborator (.+) \S+(?:: job=.*)$/)?.[1] ?? summary.collaborator;
  if (holder) return idle(`Waits for ${holder}`);
  const next = !hasDuty && nextStep(summary, now);
  return idle(next || (hasDuty ? "Waits for the coordinator" : "Not started"));
}

export function overviewTitle(inboxCount: number): string {
  return inboxCount ? `(${inboxCount}) Overview` : "Overview";
}
