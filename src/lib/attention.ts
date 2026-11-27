import { ageText, rankMoves } from "./graph.ts";
import { agentNeeds, agentName, agentsFresh, agentsWaiting, type AgentRow, type Agents, type Presence } from "./link.ts";
import type { ProjectSummary } from "./overview.ts";
import type { Project } from "./types.ts";
import { overviewMoveReason } from "./words.ts";
import { holdEnded, holdText } from "./hold.ts";

const WORKER_SILENT_MS = 20 * 60_000;
const WORKER_REPORT_GRACE_MS = 3 * 60_000;
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

const soakDeadline = (text: string): string | undefined => text.match(/^soak \S+ \S+: until (.+)$/)?.[1];
const lineTarget = (text: string) => text.split(": ", 1)[0].split(" ").at(-1);
const expectedLine = ({ level, text }: { level: string; text: string }, now: number) =>
  level === "wait" ? /^(human|owner|collaborator) /.test(text)
    || (text.startsWith("soak ") && !(Date.parse(soakDeadline(text) ?? "") <= now))
    : level === "do" && !agentLine({ level, text });

function waitsOnTarget(summary: ProjectSummary, now: number, issue?: string | null, key?: string | null): boolean {
  return !!(issue && summary.you.some((move) => move.identifier === issue)
    || summary.nextLines?.some((line) => {
      const target = lineTarget(line.text);
      return target !== "-" && (target === issue || target === key) && expectedLine(line, now);
    }));
}

function coordinatorDuties(summary: ProjectSummary, now: number, prompts: AgentRow[] = []) {
  return (summary.nextLines ?? []).flatMap<{ line: { level: string; text: string }; since: string | null }>((line) => {
    const issue = lineTarget(line.text);
    const key = line.text.split(" ")[1];
    if (waitsOnTarget(summary, now, issue, key)
      || prompts.some((row) => row.role === "worker" && (row.issue ? row.issue === issue : row.key === key))) return [];
    const explicit = (line.level === "do" && agentLine(line))
      || (line.level === "wait" && line.text.startsWith("coordinator "));
    if (explicit) return [{ line, since: null }];
    const since = line.level === "wait" ? soakDeadline(line.text) : undefined;
    if (!since || !(Date.parse(since) <= now)) return [];
    return [{ line: { level: "do", text: `ship ${key} ${issue}` }, since }];
  });
}

function reportCoversDispatch(reportAt: string, startedAt: string | null): boolean {
  const start = Date.parse(startedAt ?? "");
  return !Number.isFinite(start) || Date.parse(reportAt) >= start;
}

function dispatchWorkers(agents: Agents, job: NonNullable<ProjectSummary["liveJobs"]>[number]): AgentRow[] {
  if (!reportCoversDispatch(agents.at, job.startedAt)) return [];
  return agents.agents.filter((row) => row.role === "worker" && row.issue === job.identifier
    && reportCoversDispatch(row.at ?? "", job.startedAt));
}

function expectedWait(summary: ProjectSummary, now: number): string | null {
  const soak = summary.nextLines?.find((line) => line.text.startsWith("soak ") && expectedLine(line, now));
  if (soak) return nextStep({ ...summary, nextLines: [soak] }, now) ?? soak.text;
  if (summary.externalBlocker) return `Waits for ${summary.externalBlocker} outside the project`;
  const collaborator = summary.nextLines?.find(({ level, text }) => level === "wait" && /^(collaborator|owner) /.test(text));
  if (collaborator?.text.startsWith("owner ")) return "Waits for the owner";
  const holder = collaborator?.text.match(/^collaborator (.+) \S+(?:: job=.*)$/)?.[1] ?? summary.collaborator;
  if (holder) return `Waits for ${holder}`;
  if (summary.nextLines?.some((line) => (line.level === "wait" && line.text.startsWith("human "))
    || (line.level === "do" && !agentLine(line)))) return "Waits for human input";
  return null;
}

function coordinatorActive(presence: Presence | undefined, agents: Agents | undefined, now: number): boolean {
  return !!presence?.coordinators.some((row) => row.connected
    || (row.mode === "working" && !row.lost && now - Date.parse(row.lastSeen) < NO_COORDINATOR_MS))
    || (agentsFresh(agents, now) && agents.agents.some((row) => row.role === "coordinator" && row.state === "working"));
}

export function stalls(summary: ProjectSummary, presence: Presence | undefined, agents: Agents | undefined, now: number, readOnly = false): Stall[] {
  const coordinators = presence?.coordinators ?? [];
  if (readOnly || summary.error || summary.paused || coordinators.some((row) => row.paused)
    || summary.effort?.status === "every ship point is Done or Canceled"
    || (summary.planned > 0 && summary.done === summary.planned)) return [];

  const jobs = summary.liveJobs ?? [];
  const fresh = agentsFresh(agents, now);
  const rows = fresh ? agents.agents : [];
  const prompts = agentsWaiting(agents, now);
  const duties = coordinatorDuties(summary, now, prompts);
  const result: Stall[] = [];
  let workingJob = false;
  for (const job of jobs) {
    if (!fresh || !reportCoversDispatch(agents.at, job.startedAt)) continue;
    const workers = dispatchWorkers(agents, job);
    const key = summary.nextLines?.find(({ text }) => /^(worker|reviewer) /.test(text)
      && lineTarget(text) === job.identifier)?.text.split(" ")[1];
    if (waitsOnTarget(summary, now, job.identifier, key) || workers.some(agentNeeds)) continue;
    const running = workers.filter((row) => row.state !== "done");
    workingJob ||= running.some((row) => row.state === "working");
    const since = latest(job.startedAt, ...workers.map((row) => row.at)) ?? latest(summary.effort?.at, summary.updatedAt);
    const elapsed = now - Date.parse(since ?? "");
    const target = { issue: job.identifier, title: job.title, since };
    if (running.length && running.every((row) => row.state === "working") && elapsed >= WORKER_SILENT_MS) {
      result.push({ ...target, kind: "worker-silent", reason: "Worker silent" });
    } else if (!running.length && elapsed >= WORKER_REPORT_GRACE_MS) {
      result.push({ ...target, kind: "worker-gone", reason: "No matching worker in the agent report" });
    }
  }

  const ready = summary.ready > 0 && !!summary.freshness
    && !summary.you.length && !expectedWait(summary, now) && !prompts.length;
  if ((presence || fresh) && (duties.length || ready || workingJob)
    && !prompts.some((row) => row.role === "coordinator") && !coordinatorActive(presence, agents, now)) {
    // Ready issues can change after the last next report. Give the newer evidence the full grace period.
    const last = latest(summary.effort?.at, summary.freshness?.ran, ready ? summary.updatedAt : undefined,
      ...jobs.map((job) => job.startedAt), ...coordinators.map((row) => row.lastSeen),
      ...rows.filter((row) => row.role === "coordinator").map((row) => row.at)) ?? latest(summary.updatedAt);
    const since = ready || workingJob || duties.some((duty) => !duty.since)
      ? last
      : latest(last, duties.map((duty) => duty.since).sort()[0]);
    if (now - Date.parse(since ?? "") >= NO_COORDINATOR_MS) {
      result.push({ kind: "no-coordinator", reason: "Waiting for a coordinator report", since });
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

export const PROJECT_STATES = ["stalled", "waits", "moving", "idle", "held"] as const;
export type ProjectStateName = (typeof PROJECT_STATES)[number];
export interface ProjectState { state: ProjectStateName; reason: string }

interface ProjectActivity {
  now: number;
  project?: Pick<Project, "paused" | "statusType" | "hold">;
  presence?: Presence;
  agents?: Agents;
  stalls?: Stall[];
}

export function projectState(summary: ProjectSummary | null, activity: ProjectActivity): ProjectState {
  const { now, project, presence, agents } = activity;
  // A held effort (the label `on-hold`) leaves the list until its hold ends; then it waits on the human's Resume.
  if (project && "hold" in project && project.statusType !== "completed" && project.statusType !== "canceled") {
    const ended = project.hold && holdEnded(project.hold, now);
    if (ended) return { state: "waits", reason: `Hold ended · ${ended} · Resume to let the coordinator act` };
    return { state: "held", reason: project.hold ? holdText(project.hold, now) : "On hold" };
  }
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
  if (project?.statusType === "canceled") return idle("Canceled");
  if (complete) return idle("Each node is done");
  if (summary?.error) return idle("Project details unavailable");
  if (!summary) return idle("Project details are loading");
  if (summary.planned > 0 && summary.done === summary.planned) return idle("Each node is done");

  const prompts = agentsWaiting(agents, now);
  const fresh = agentsFresh(agents, now);
  const prompt = prompts.find((row) => row.role === "coordinator"
    || (fresh && summary.liveJobs?.some((job) => dispatchWorkers(agents, job).includes(row))));
  if (prompt) return { state: "waits", reason: `${agentName(prompt)} ${agentNeeds(prompt)}` };

  const job = fresh ? summary.liveJobs?.find((job) =>
    dispatchWorkers(agents, job).some((row) => row.state === "working")) : undefined;
  if (job) {
    const line = summary.nextLines?.find(({ level, text }) => level === "wait"
      && /^(worker|reviewer) /.test(text) && text.split(/[: ]/, 3)[2] === job.identifier);
    return { state: "moving", reason: (line && nextStep({ ...summary, nextLines: [line] }, now)) || `Worker on ${job.identifier}` };
  }

  if (paused) return idle("Paused");
  const [duty] = coordinatorDuties(summary, now, prompts);
  if (duty) {
    return coordinatorActive(presence, agents, now)
      ? { state: "moving", reason: nextStep({ ...summary, nextLines: [duty.line] }, now) ?? "Coordinator working" }
      : idle("Waits for the coordinator");
  }
  const wait = expectedWait(summary, now);
  if (wait) return idle(wait);
  const reportedJob = summary.liveJobs?.[0];
  if (reportedJob) {
    if (!agents) return idle(`No agent report for ${reportedJob.identifier}`);
    if (!agentsFresh(agents, now)) return idle(`Agent report for ${reportedJob.identifier} is stale`);
    if (!reportCoversDispatch(agents.at, reportedJob.startedAt)) {
      return idle(`No agent report for the current dispatch of ${reportedJob.identifier}`);
    }
    return idle(`No active worker reported for ${reportedJob.identifier}`);
  }
  const next = nextStep(summary, now);
  if (next) return idle(next);
  if (summary.ready > 0) return idle("Work is ready");
  if (summary.running || summary.review) return idle("No live job reported");
  return idle(summary.done || summary.counts.some(({ signal }) => signal === "merged") ? "No work running" : "Not started");
}

export function overviewTitle(inboxCount: number): string {
  return inboxCount ? `(${inboxCount}) Overview` : "Overview";
}
