// Linear GraphQL access for the work-graph UI. The API key stays in this process.
import type { Comment, GraphData, Issue, IssuePatch, IssueRef, Label, Milestone, Person, Project, PullRequest, State, Team } from "../src/lib/types.ts";
import { site } from "../src/lib/site.ts";
import { ANSWERED_LABEL, AUTONOMY_GROUP, type AutonomyLevel, autonomyOf, PAUSED_LABEL, pausedOf, SHARED_LABEL, sharedOf } from "../src/lib/autonomy.ts";
import { REVIEW_GROUP, type ReviewEffort, reviewLabel, reviewOf } from "../src/lib/review.ts";
import { linearWorkspace } from "./workspaces.ts";

const ENDPOINT = "https://api.linear.app/graphql";
export const CARD_PREFIX = "**work-graph node card**";
/** The title of the project document that `wg next` writes (contract.json `status_doc`). */
export const STATUS_DOC = "work-graph status";
/** The team's project label group whose children are the initiatives (contract.json `project_labels.initiative_group`). */
export const INITIATIVE_GROUP = "initiative";
export const KIND_LABELS = new Set(["merge-point", "ship-point", "ops", "decision", "spike"]);

/** An error with the HTTP status that the API answers with. */
export class LinearError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

// Linear's answers, as far as this module reads them.
interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface RawLabel { id: string; name: string; color: string; parent: { name: string } | null }
interface RawUser { id: string; name: string; displayName: string; avatarUrl: string | null }
interface RawRef { id: string; identifier: string; title: string; url: string; team: { key: string }; state: State; project: { id: string } | null }
interface RawAttachment { url: string | null; title: string | null; metadata: Record<string, unknown> | null }
interface RawIssue {
  project?: { id: string; name: string } | null;
  id: string; identifier: string; title: string; description: string | null; priority: number; url: string;
  sortOrder: number; updatedAt: string; team: { id: string; key: string }; state: State; assignee: RawUser | null;
  labels: { nodes: RawLabel[] }; projectMilestone: { id: string } | null;
  relations: Connection<{ type: string; relatedIssue: RawRef }>;
  inverseRelations: Connection<{ type: string; issue: RawRef }>;
  comments: { nodes: { id: string; body: string }[] };
  attachments: { nodes: RawAttachment[] } | null;
}
interface RawComment {
  id: string; body: string | null; createdAt: string; parent: { id: string } | null;
  user: { name: string; displayName: string } | null; botActor: { name: string } | null;
}

// The GraphQL answers are not checked against a schema: each caller names the shape it reads.
type Data = any;

/** At most this many Linear requests of this process run at the same time. */
export const MAX_PARALLEL = 6;
/** The tries of one request, the first one included. */
export const MAX_TRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const TIMEOUT_MS = 30_000;

/** What `gql` uses to reach Linear. Tests replace it with `setTransport`. */
export interface Transport {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** A number in [0, 1), for the jitter of the delay. */
  random: () => number;
  now: () => number;
}
const defaultTransport: Transport = {
  // globalThis.fetch is read at each call, so a test that stubs it still works.
  fetch: (url, init) => globalThis.fetch(url, init),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  random: Math.random,
  now: Date.now,
};
let transport = defaultTransport;
/** Replaces parts of the transport; no argument puts the default back. */
export function setTransport(parts: Partial<Transport> = {}): void {
  transport = { ...defaultTransport, ...parts };
}

/** A counting semaphore: `run` waits until fewer than `size` calls are active. */
export function limiter(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= size) await new Promise<void>((go) => waiting.push(go));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
const slot = limiter(MAX_PARALLEL);

/** Maps the items with at most `size` calls of `fn` active at the same time; the order of the items stays. */
export async function mapLimit<T, U>(items: T[], size: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** The rate-limit values of the last Linear response of a workspace (Linear's `X-RateLimit-*` headers). */
export interface LinearBudget {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  /** When the request budget is full again, epoch ms. */
  requestsReset: number | null;
  complexityRemaining: number | null;
  complexityLimit: number | null;
  complexityReset: number | null;
  /** When the server read these values, epoch ms. */
  at: number;
}
const budgets = new Map<string, LinearBudget>();
const workspaceId = () => linearWorkspace.getStore()?.id ?? "default";

/** The last rate-limit values of a workspace (default: the workspace of this request), or null before the first response. */
export function linearBudget(workspace: string = workspaceId()): LinearBudget | null {
  return budgets.get(workspace) ?? null;
}

function keepBudget(headers: Headers | undefined): void {
  if (!headers || typeof headers.get !== "function") return;
  const number = (name: string) => {
    const text = headers.get(`x-ratelimit-${name}`);
    const value = text === null ? NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  };
  const budget: LinearBudget = {
    requestsRemaining: number("requests-remaining"), requestsLimit: number("requests-limit"),
    requestsReset: number("requests-reset"),
    complexityRemaining: number("complexity-remaining"), complexityLimit: number("complexity-limit"),
    complexityReset: number("complexity-reset"),
    at: transport.now(),
  };
  if (Object.entries(budget).some(([k, v]) => k !== "at" && v !== null)) budgets.set(workspaceId(), budget);
}

/** Why a try failed, as far as the retry rule needs it. */
type Failure = "network" | "timeout" | "rate" | "server" | "final";

/**
 * Does a GraphQL document hold a mutation operation? The operation can come after fragments, so each
 * definition at the top level is read, not only the first. Strings and `#` comments are removed first.
 * A word at the top level that follows `fragment`, `query`, or `subscription` is a name, not a keyword.
 */
export function isMutation(document: string): boolean {
  const text = document.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\\n\r])*"|#[^\n\r]*/g, " ");
  let depth = 0;
  let previous = "";
  for (const [token] of text.matchAll(/[{}()[\]]|[$@]?[_A-Za-z][_0-9A-Za-z]*/g)) {
    if (token === "{" || token === "(" || token === "[") depth++;
    else if (token === "}" || token === ")" || token === "]") depth--;
    else if (depth === 0) {
      if (token === "mutation" && !["fragment", "query", "subscription"].includes(previous)) return true;
      previous = token;
    }
  }
  return false;
}
/**
 * A query is safe to send again. A mutation is sent again only when Linear refused it before it did
 * anything (HTTP 429 or RATELIMITED): after a timeout or a 5xx, Linear can have applied it.
 */
const retryable = (failure: Failure, mutation: boolean) =>
  failure === "rate" || (!mutation && failure !== "final");

/**
 * The delay before the next try, or null when Linear asks for a longer wait than this server supports.
 * The exponential delay with jitter is capped at MAX_DELAY_MS; `Retry-After` is a minimum, never cut short.
 */
export function delay(tryNumber: number, retryAfter: string | null): number | null {
  const exponential = BASE_DELAY_MS * 2 ** (tryNumber - 1);
  const jittered = Math.min(MAX_DELAY_MS, exponential / 2 + transport.random() * exponential);
  const seconds = retryAfter === null || retryAfter.trim() === "" ? NaN : Number(retryAfter);
  const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  if (asked > MAX_DELAY_MS) return null;
  return Math.max(jittered, asked);
}

/** A try whose request or response body did not arrive: a timeout or a network error. */
function transportFailure(error: unknown): { failure: Failure; error: LinearError; retryAfter: null } {
  const name = (error as Error).name;
  const failure: Failure = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
  return { failure, error: new LinearError(`Linear request failed: ${(error as Error).message}`), retryAfter: null };
}

interface GraphQLError { message: string; extensions?: { code?: string } }

export async function gql(query: string, variables: Record<string, unknown> = {}): Promise<Data> {
  const key = linearWorkspace.getStore()?.key ?? process.env.LINEAR_API_KEY;
  if (!key) throw new LinearError("LINEAR_API_KEY is not set", 500);
  const mutation = isMutation(query);
  const init = (): RequestInit => ({
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  for (let tryNumber = 1; ; tryNumber++) {
    // The slot is held for one try only, not during the delay before the next try.
    const result = await slot(async (): Promise<{ data: Data } | { failure: Failure; error: LinearError; retryAfter: string | null }> => {
      let response: Response;
      try {
        response = await transport.fetch(ENDPOINT, init());
      } catch (error) {
        return transportFailure(error);
      }
      keepBudget(response.headers);
      let body: { data?: Data; errors?: GraphQLError[] } | null;
      try {
        body = await response.json();
      } catch (error) {
        // Text that is not JSON is Linear's answer. A timeout or a dropped connection while the body
        // arrives is a failed transport, the same as one before the headers. HTTP 429 is known from the
        // headers already: it stays a rate limit, so a mutation tries again after its Retry-After.
        if (!(error instanceof SyntaxError) && response.status !== 429) return transportFailure(error);
        body = null;
      }
      if (response.ok && body && !body.errors) return { data: body.data };
      const detail = body?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${response.status}`;
      const rated = response.status === 429 || !!body?.errors?.some((e) => e.extensions?.code === "RATELIMITED");
      const failure: Failure = rated ? "rate" : response.status >= 500 ? "server" : "final";
      const retryAfter = typeof response.headers?.get === "function" ? response.headers.get("retry-after") : null;
      return { failure, error: new LinearError(rated ? `Linear rate limit: ${detail}` : `Linear: ${detail}`, rated ? 429 : 502), retryAfter };
    });
    if ("data" in result) return result.data;
    if (tryNumber >= MAX_TRIES || !retryable(result.failure, mutation)) throw result.error;
    const wait = delay(tryNumber, result.retryAfter);
    if (wait === null) throw result.error;
    await transport.sleep(wait);
  }
}

async function pages<T>(query: string, variables: Record<string, unknown>, pick: (data: Data) => Connection<T>): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  do {
    const connection: Connection<T> = pick(await gql(query, { ...variables, after }));
    out.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const STATE = "state{id name type color}";
const REF = `id identifier title url team{key} ${STATE} project{id}`;
const RELATIONS = `nodes{type relatedIssue{${REF}}} pageInfo{hasNextPage endCursor}`;
const INVERSE_RELATIONS = `nodes{type issue{${REF}}} pageInfo{hasNextPage endCursor}`;
// Linear refuses a query that costs more than 10,000 points. One issue with 30 relations each way costs
// about 400, so 25 issues of that size are too many. completeIssue loads the relations past this page.
const RELATION_PAGE = 20;
const ISSUE = `id identifier title description priority url sortOrder updatedAt
  project{id name}
  team{id key} ${STATE} assignee{id name displayName avatarUrl}
  labels(first:20){nodes{id name color parent{name}}}
  projectMilestone{id}
  relations(first:${RELATION_PAGE},includeArchived:true){${RELATIONS}}
  inverseRelations(first:${RELATION_PAGE},includeArchived:true){${INVERSE_RELATIONS}}
  comments(first:1, filter:{body:{startsWith:"${CARD_PREFIX}"}}){nodes{id body}}
  attachments(first:20){nodes{url title sourceType metadata}}`;

const label = (l: RawLabel): Label => ({ id: l.id, name: l.name, color: l.color, group: l.parent?.name ?? null });
const person = (u: RawUser | null): Person | null => (u ? { id: u.id, name: u.displayName || u.name, avatarUrl: u.avatarUrl ?? null } : null);
const ref = (i: RawRef, projectId: string | undefined): IssueRef => ({
  id: i.id, identifier: i.identifier, title: i.title, url: i.url, teamKey: i.team.key,
  state: i.state, inProject: i.project?.id === projectId,
});

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;

/** The GitHub pull requests linked to an issue. `reviewUrl` (Linear's review page) is filled in later. */
export function pullRequestsOf(attachments: { nodes: RawAttachment[] } | null | undefined): PullRequest[] {
  const seen = new Set<string>();
  return (attachments?.nodes ?? []).flatMap((a) => {
    const m = a.url?.match(PR_URL);
    if (!m || seen.has(m[0])) return [];
    seen.add(m[0]);
    const meta = a.metadata ?? {};
    const status = (meta.status as string | undefined) ?? (meta.mergedAt ? "merged" : meta.closedAt ? "closed" : "open");
    return [{ number: Number(m[1]), url: m[0], title: (meta.title as string | undefined) ?? a.title ?? "", status, reviewUrl: null }];
  });
}

/**
 * Adds the Linear review page to each pull request. Linear's public schema does not list
 * `pullRequests`, but the API answers it; a failure leaves `reviewUrl` empty and the page
 * shows the GitHub link only.
 */
export async function addReviewUrls(issues: Pick<Issue, "url" | "pullRequests">[]): Promise<void> {
  const prs = issues.flatMap((i) => i.pullRequests);
  const workspace = issues.map((i) => i.url.match(/^https:\/\/linear\.app\/([^/]+)\//)?.[1]).find(Boolean);
  if (!prs.length || !workspace) return;
  const slugs = new Map<string, string>();
  const numbers = [...new Set(prs.map((p) => p.number))];
  try {
    for (let at = 0; at < numbers.length; at += 50) {
      const data = await gql(`query($n:[Float!]){ pullRequests(first:100,filter:{number:{in:$n}}){ nodes{ slugId url } } }`, { n: numbers.slice(at, at + 50) });
      for (const p of data.pullRequests.nodes as { slugId: string; url: string }[]) slugs.set(p.url, p.slugId);
    }
  } catch (error) {
    console.warn(`wg ui: no Linear review links: ${(error as Error).message}`);
  }
  for (const p of prs) if (slugs.has(p.url)) p.reviewUrl = `https://linear.app/${workspace}/review/${slugs.get(p.url)}`;
}

export function normalizeIssue(i: RawIssue, projectId: string | undefined): Issue {
  return {
    id: i.id, identifier: i.identifier, title: i.title, description: i.description ?? "",
    priority: i.priority, url: i.url, sortOrder: i.sortOrder, updatedAt: i.updatedAt,
    teamId: i.team.id, teamKey: i.team.key, state: i.state, assignee: person(i.assignee),
    labels: i.labels.nodes.map(label), milestoneId: i.projectMilestone?.id ?? null,
    blocks: i.relations.nodes.filter((r) => r.type === "blocks").map((r) => ref(r.relatedIssue, projectId)),
    blockedBy: i.inverseRelations.nodes.filter((r) => r.type === "blocks").map((r) => ref(r.issue, projectId)),
    card: i.comments.nodes[0] ?? null, external: false, pullRequests: pullRequestsOf(i.attachments),
  };
}

async function completeIssue(issue: RawIssue, projectId: string | undefined): Promise<Issue> {
  const nextCursor = (page: Connection<unknown>, previous: string | null) => {
    const { hasNextPage, endCursor } = page.pageInfo;
    return hasNextPage && endCursor !== previous ? endCursor : null;
  };
  let afterRelations = nextCursor(issue.relations, null);
  let afterInverseRelations = nextCursor(issue.inverseRelations, null);
  while (afterRelations || afterInverseRelations) {
    const data = await gql(
      `query($id:String!,$afterRelations:String,$afterInverseRelations:String,$moreRelations:Boolean!,$moreInverseRelations:Boolean!){
        issue(id:$id){
          relations(first:${RELATION_PAGE},after:$afterRelations,includeArchived:true) @include(if:$moreRelations){${RELATIONS}}
          inverseRelations(first:${RELATION_PAGE},after:$afterInverseRelations,includeArchived:true) @include(if:$moreInverseRelations){${INVERSE_RELATIONS}}
        }
      }`,
      {
        id: issue.id, afterRelations, afterInverseRelations,
        moreRelations: !!afterRelations, moreInverseRelations: !!afterInverseRelations,
      },
    );
    if (afterRelations) {
      const page = data.issue.relations;
      issue.relations.nodes.push(...page.nodes);
      afterRelations = nextCursor(page, afterRelations);
    }
    if (afterInverseRelations) {
      const page = data.issue.inverseRelations;
      issue.inverseRelations.nodes.push(...page.nodes);
      afterInverseRelations = nextCursor(page, afterInverseRelations);
    }
  }
  return normalizeIssue(issue, projectId);
}

/** The initiative of a project: its label in the group `initiative`. The group is single-select. */
export function initiativeOf(labels: { name: string; parent: { name: string } | null }[] | undefined): string | null {
  return labels?.find((l) => l.parent?.name.toLowerCase() === INITIATIVE_GROUP)?.name ?? null;
}

export async function listProjects(teamKey: string): Promise<Project[]> {
  type RawProject = {
    id: string; name: string; url: string; status: { name: string; type: string } | null;
    labels?: { nodes: { name: string; parent: { name: string } | null }[] } | null;
    marks?: { nodes: { name: string; parent: { name: string } | null }[] } | null;
  };
  const projects = await pages<RawProject>(
    `query($k:String!,$after:String){ teams(first:1,filter:{key:{eq:$k}}){ nodes{
       projects(first:50,after:$after){ nodes{id name url status{name type} labels(first:20){nodes{name parent{name}}}
           marks: labels(first:10, filter:{name:{in:["${PAUSED_LABEL}","${SHARED_LABEL}"]}}){nodes{name parent{name}}}}
         pageInfo{hasNextPage endCursor} } } } }`,
    { k: teamKey },
    (data) => {
      if (!data.teams.nodes.length) throw new LinearError(`team ${teamKey} not found`, 404);
      return data.teams.nodes[0].projects;
    },
  );
  return projects
    .map((p) => ({ id: p.id, name: p.name, url: p.url, status: p.status?.name ?? "", statusType: p.status?.type ?? "", initiative: initiativeOf(p.labels?.nodes), autonomy: autonomyOf(p.labels?.nodes), review: reviewOf(p.labels?.nodes), // The two plain marks also come by name: a project can have more labels than the first 20.
      paused: pausedOf(p.labels?.nodes) || pausedOf(p.marks?.nodes), shared: sharedOf(p.labels?.nodes) || sharedOf(p.marks?.nodes) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Give the project the autonomy level `level`: the child `level` of the single-select project label group
 * `autonomy`, made when it is missing, as `wg autonomy` does. Team labels with `teamScoped`; else workspace
 * labels (the personal workspace: team project labels need Linear's Business plan).
 */
export function setAutonomy(projectId: string, level: AutonomyLevel, teamKey: string, teamScoped: boolean): Promise<void> {
  return setGroupLabel(projectId, teamKey, teamScoped, { group: AUTONOMY_GROUP, child: level, noun: "autonomy label",
    description: "work-graph: the autonomy level of each effort (full, standard, supervised). The coordinator follows it; change it on the work-graph page at any time." });
}

/**
 * Give the project the review effort `level`: the child `review:<level>` of the single-select project label group
 * `review`, as `wg review-effort` does. It replaces an old child without the prefix. Same scope rule as `setAutonomy`.
 */
export function setReviewEffort(projectId: string, level: ReviewEffort, teamKey: string, teamScoped: boolean): Promise<void> {
  return setGroupLabel(projectId, teamKey, teamScoped, { group: REVIEW_GROUP, child: reviewLabel(level), noun: "review effort label",
    description: "work-graph: the review effort of each effort (thorough, standard, light). The coordinator follows it; change it on the work-graph page at any time." });
}

/** Give the project the child `child` of the single-select project label group `group`, and no other child of it. Group and child are made when missing. */
async function setGroupLabel(projectId: string, teamKey: string, teamScoped: boolean, label: { group: string; child: string; noun: string; description: string }): Promise<void> {
  type RawProjectLabel = { id: string; name: string; isGroup: boolean; retiredAt: string | null; parent: { id: string } | null };
  const info = await gql(`query($id:String!,$k:String!){ project(id:$id){ id teams(first:10){nodes{key}} labels(first:50){nodes{id parent{id}}} }
    teams(first:1,filter:{key:{eq:$k}}){ nodes{id} } }`, { id: projectId, k: teamKey });
  const project = info.project as { id: string; teams: { nodes: { key: string }[] }; labels: { nodes: { id: string; parent: { id: string } | null }[] } } | null;
  if (!project) throw new LinearError("project not found", 404);
  if (!project.teams.nodes.some((t) => t.key === teamKey)) throw new LinearError(`the project is not in team ${teamKey}`, 403);
  const teamId = info.teams.nodes[0]?.id as string | undefined;
  if (!teamId) throw new LinearError(`team ${teamKey} not found`, 404);
  const scope = teamScoped ? { team: { id: { eq: teamId } } } : { team: { null: true } };
  const owner = teamScoped ? { teamId } : {};
  const labels = (await gql(`query($f:ProjectLabelFilter!){ projectLabels(first:250, filter:$f){ nodes{id name isGroup retiredAt parent{id}} } }`,
    { f: scope })).projectLabels.nodes as RawProjectLabel[];
  const create = async (input: Record<string, unknown>) =>
    (await gql(`mutation($i:ProjectLabelCreateInput!){ projectLabelCreate(input:$i){ projectLabel{id} } }`, { i: input })).projectLabelCreate.projectLabel.id as string;
  const found = labels.find((l) => l.isGroup && l.name.toLowerCase() === label.group);
  if (found?.retiredAt) throw new LinearError(`the project label group ${label.group} is retired; restore it in Linear`, 409);
  const group = found?.id ?? await create({ name: label.group, ...owner, isGroup: true, groupType: "singleSelect", description: label.description });
  const child = labels.find((l) => l.parent?.id === group && l.name === label.child);
  if (child?.retiredAt) throw new LinearError(`the ${label.noun} ${label.child} is retired; restore it in Linear`, 409);
  const childId = child?.id ?? await create({ name: label.child, ...owner, parentId: group });
  for (const label of project.labels.nodes) {
    if (label.parent?.id === group && label.id !== childId) {
      await gql(`mutation($id:String!,$l:String!){ projectRemoveLabel(id:$id, labelId:$l){ success } }`, { id: projectId, l: label.id });
    }
  }
  if (!project.labels.nodes.some((l) => l.id === childId)) {
    await gql(`mutation($id:String!,$l:String!){ projectAddLabel(id:$id, labelId:$l){ success } }`, { id: projectId, l: childId });
  }
}

/**
 * Pause or resume the effort: the plain project label `paused`, made when it is missing. The label is the record,
 * so a pause survives a restart of this server; `wg next` reads it. Same scope rule as the autonomy label.
 */
export const setPaused = (projectId: string, paused: boolean, teamKey: string, teamScoped: boolean): Promise<void> =>
  setPlainLabel(projectId, PAUSED_LABEL, paused, teamKey, teamScoped, `work-graph: the coordinator holds each action until ${site.human} resumes the effort.`);

/** Shares a project with the read-only viewer, or stops that: the plain project label `shared` is the record. */
export const setShared = (projectId: string, shared: boolean, teamKey: string, teamScoped: boolean): Promise<void> =>
  setPlainLabel(projectId, SHARED_LABEL, shared, teamKey, teamScoped, "work-graph: the read-only viewer shows this project.");

/**
 * Puts the plain project label `name` on a project of the team, or removes it. It makes the label when the team
 * (or the workspace, with `teamScoped` false) has none.
 */
async function setPlainLabel(projectId: string, name: string, on: boolean, teamKey: string, teamScoped: boolean, description: string): Promise<void> {
  const info = await gql(`query($id:String!,$k:String!){ project(id:$id){ id teams(first:10){nodes{key}} labels(first:50){nodes{id name parent{id}}} }
    teams(first:1,filter:{key:{eq:$k}}){ nodes{id} } }`, { id: projectId, k: teamKey });
  const project = info.project as { teams: { nodes: { key: string }[] }; labels: { nodes: { id: string; name: string; parent: { id: string } | null }[] } } | null;
  if (!project) throw new LinearError("project not found", 404);
  if (!project.teams.nodes.some((t) => t.key === teamKey)) throw new LinearError(`the project is not in team ${teamKey}`, 403);
  const has = project.labels.nodes.find((l) => !l.parent && l.name === name);
  if (!on) {
    if (has && !(await gql(`mutation($id:String!,$l:String!){ projectRemoveLabel(id:$id, labelId:$l){ success } }`, { id: projectId, l: has.id })).projectRemoveLabel.success) {
      throw new LinearError(`Linear did not remove the project label ${name}`, 502);
    }
    return;
  }
  if (has) return;
  const teamId = info.teams.nodes[0]?.id as string | undefined;
  if (!teamId) throw new LinearError(`team ${teamKey} not found`, 404);
  const scope = teamScoped ? { team: { id: { eq: teamId } } } : { team: { null: true } };
  const labels = (await gql(`query($f:ProjectLabelFilter!){ projectLabels(first:250, filter:$f){ nodes{id name isGroup retiredAt parent{id}} } }`,
    { f: scope })).projectLabels.nodes as { id: string; name: string; isGroup: boolean; retiredAt: string | null; parent: { id: string } | null }[];
  const found = labels.find((l) => !l.isGroup && !l.parent && l.name === name);
  if (found?.retiredAt) throw new LinearError(`the project label ${name} is retired; restore it in Linear`, 409);
  const labelId = found?.id ?? (await gql(`mutation($i:ProjectLabelCreateInput!){ projectLabelCreate(input:$i){ projectLabel{id} } }`,
    { i: { name, ...(teamScoped ? { teamId } : {}), description } })).projectLabelCreate.projectLabel.id as string;
  if (!(await gql(`mutation($id:String!,$l:String!){ projectAddLabel(id:$id, labelId:$l){ success } }`, { id: projectId, l: labelId })).projectAddLabel.success) {
    throw new LinearError(`Linear did not add the project label ${name}`, 502);
  }
}

/**
 * Mark the human's answer from the page: the workspace issue label `answered` (made when it is missing, as
 * `wg` makes `needs-<human>`). `wg next` prints `do answer` while it is on a Needs <human> issue, so the
 * answer survives a restart of this server; any `wg move` of the issue removes it.
 */
export async function markAnswered(issueId: string): Promise<void> {
  const found = (await gql(`query($n:String!){ issueLabels(first:10, filter:{name:{eq:$n}, team:{null:true}}){ nodes{id} } }`,
    { n: ANSWERED_LABEL })).issueLabels.nodes as { id: string }[];
  const labelId = found[0]?.id ?? (await gql(`mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ issueLabel{id} } }`,
    { i: { name: ANSWERED_LABEL } })).issueLabelCreate.issueLabel.id as string;
  const data = await gql(`mutation($id:String!,$l:[String!]){ issueUpdate(id:$id, input:{addedLabelIds:$l}){ success } }`, { id: issueId, l: [labelId] });
  if (!data.issueUpdate?.success) throw new LinearError("Linear did not add the answered label");
}

/** Explicit project closeout. Do not follow blocking relations into other projects. */
export async function closeProject(projectId: string, confirm: unknown, teamKey: string): Promise<{ completedIssues: number }> {
  if (confirm !== true) throw new LinearError("confirm that every issue will be marked Done", 400);
  if (projectId === "all") throw new LinearError("select a project to close", 400);
  const info = await gql(`query CloseProjectInfo($id:String!){
    project(id:$id){id name teams{nodes{key}}}
    projectStatuses{nodes{id name type}}
  }`, { id: projectId });
  if (!info.project) throw new LinearError("project not found", 404);
  projectId = info.project.id;
  if (!info.project.teams.nodes.some((t: { key: string }) => t.key === teamKey)) {
    throw new LinearError(`this project is not in team ${teamKey}: it is read-only here`, 403);
  }
  const statuses = info.projectStatuses.nodes as { id: string; name: string; type: string }[];
  const completed = statuses.find((s) => s.type === "completed" && s.name === "Completed")
    ?? statuses.find((s) => s.type === "completed");
  if (!completed) throw new LinearError("no completed project status is available", 400);
  type CloseIssue = { id: string; trashed: boolean | null; state: { id: string }; team: { key: string; states: { nodes: State[] } } };
  const issues = await pages<CloseIssue>(
    `query CloseProjectIssues($id:ID!,$after:String){
      issues(first:50,after:$after,includeArchived:true,filter:{project:{id:{eq:$id}}}){
        nodes{id trashed state{id} team{key states{nodes{id name type}}}}
        pageInfo{hasNextPage endCursor}
      }
    }`, { id: projectId }, (data) => data.issues,
  );
  // Check the whole project before the first write. Other teams remain read-only here.
  const moves = issues.filter((issue) => !issue.trashed).map((issue) => {
    if (issue.team.key !== teamKey) throw new LinearError(`project contains issues outside team ${teamKey}: close it in Linear`, 403);
    const done = issue.team.states.nodes.find((s) => s.name === "Done" && s.type === "completed");
    if (!done) throw new LinearError(`team ${teamKey} has no Done status`, 400);
    return { issue, done };
  });
  let completedIssues = 0;
  for (const { issue, done } of moves) {
    if (issue.state.id === done.id) continue;
    const result = await gql(`mutation($id:String!,$stateId:String!){
      issueUpdate(id:$id,input:{stateId:$stateId}){success}
    }`, { id: issue.id, stateId: done.id });
    if (!result.issueUpdate.success) throw new LinearError("could not mark every issue Done; the project was not closed. Retry to finish.");
    completedIssues++;
  }
  const result = await gql(`mutation($id:String!,$statusId:String!){
    projectUpdate(id:$id,input:{statusId:$statusId}){success}
  }`, { id: projectId, statusId: completed.id });
  if (!result.projectUpdate.success) throw new LinearError("issues are Done, but the project could not be closed. Retry to finish.");
  return { completedIssues };
}

/**
 * Did an issue or a comment of the project change after `since`? One request. A changed node card
 * is a changed comment: Linear does not change the issue for it.
 */
export async function changedSince(projectId: string, since: string): Promise<boolean> {
  const scope = "project:{id:{eq:$id}}";
  const data = await gql(
    `query($id:ID!,$projectId:String!,$t:DateTimeOrDuration!){
       issues(first:1, filter:{${scope}, updatedAt:{gt:$t}}){ nodes{id} }
       comments(first:1, filter:{issue:{${scope}}, updatedAt:{gt:$t}}){ nodes{id} }
       project(id:$projectId){
         documents(first:1, filter:{title:{eq:"${STATUS_DOC}"}, updatedAt:{gt:$t}}){ nodes{id} }
       } }`,
    { id: projectId, projectId, t: since },
  );
  return data.issues.nodes.length > 0 || data.comments.nodes.length > 0
    || (data.project?.documents.nodes.length ?? 0) > 0;
}

/** How many requests `changedProjects` makes at most. More changes than these pages hold: all changed. */
export const CHANGED_PAGES = 3;
const CHANGED_PAGE = 100;

/**
 * Which of these projects changed after `since`: one question for all of them, not one for each.
 * The answer maps each changed project to the time of its latest change, so a caller can compare each
 * project with its own time. It looks at issues, comments (node cards), and the status document of each
 * project. Null: more changes than `CHANGED_PAGES` requests hold, so treat every project as changed.
 */
export async function changedProjects(ids: string[], since: string): Promise<Map<string, string> | null> {
  const changed = new Map<string, string>();
  if (!ids.length) return changed;
  // Times as numbers: two ISO texts of one time can differ in precision or offset.
  const note = (projectId: string | undefined, at: string) => {
    if (!projectId || !ids.includes(projectId)) return;
    const before = changed.get(projectId);
    if (before === undefined || Date.parse(at) > Date.parse(before)) changed.set(projectId, at);
  };
  const scope = "project:{id:{in:$ids}}";
  const page = "pageInfo{hasNextPage endCursor}";
  // The status document of each project is an alias of the first request.
  const docs = ids.map((_, at) =>
    `d${at}: project(id:$d${at}){ documents(first:1, filter:{title:{eq:"${STATUS_DOC}"}, updatedAt:{gt:$t}}){ nodes{updatedAt} } }`);
  let issuesAfter: string | null = null, commentsAfter: string | null = null;
  for (let request = 1; ; request++) {
    const first = request === 1;
    const parts: string[] = [], params = ["$ids:[ID!]!", "$t:DateTimeOrDuration!"];
    const variables: Record<string, unknown> = { ids, t: since };
    if (first || issuesAfter) {
      params.push("$ia:String");
      variables.ia = issuesAfter;
      parts.push(`issues(first:${CHANGED_PAGE}, after:$ia, filter:{${scope}, updatedAt:{gt:$t}}){ nodes{updatedAt project{id}} ${page} }`);
    }
    if (first || commentsAfter) {
      params.push("$ca:String");
      variables.ca = commentsAfter;
      parts.push(`comments(first:${CHANGED_PAGE}, after:$ca, filter:{issue:{${scope}}, updatedAt:{gt:$t}}){ nodes{updatedAt issue{project{id}}} ${page} }`);
    }
    if (first) ids.forEach((id, at) => { params.push(`$d${at}:String!`); variables[`d${at}`] = id; });
    const data = await gql(`query(${params.join(",")}){ ${[...parts, ...(first ? docs : [])].join("\n")} }`, variables);
    if (first) ids.forEach((id, at) => { for (const d of data[`d${at}`]?.documents.nodes ?? []) note(id, d.updatedAt); });
    if (data.issues) {
      for (const i of data.issues.nodes) note(i.project?.id, i.updatedAt);
      issuesAfter = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    }
    if (data.comments) {
      for (const c of data.comments.nodes) note(c.issue?.project?.id, c.updatedAt);
      commentsAfter = data.comments.pageInfo.hasNextPage ? data.comments.pageInfo.endCursor : null;
    }
    if (!issuesAfter && !commentsAfter) return changed;
    if (request >= CHANGED_PAGES) return null;
  }
}

/** The states, members, and labels of the teams change seldom: one load serves ten minutes. */
const META_MS = 10 * 60_000;
const metaCache = new Map<string, { at: number; teams: Record<string, Team>; labels: Label[] }>();

export async function loadGraph(projectId: string): Promise<GraphData> {
  const head = await gql(
    `query($id:String!){ viewer{id} project(id:$id){ id name url
       projectMilestones(first:50){nodes{id name sortOrder description}}
       documents(first:5, filter:{title:{eq:"${STATUS_DOC}"}}){nodes{content updatedAt}} } }`,
    { id: projectId },
  );
  if (!head.project) throw new LinearError(`project ${projectId} not found`, 404);
  const raw = await pages<RawIssue>(
    `query($id:String!,$after:String){ project(id:$id){ issues(first:25,after:$after){
       nodes{${ISSUE}} pageInfo{hasNextPage endCursor} } } }`,
    { id: projectId },
    (data) => data.project.issues,
  );
  const issues = await mapLimit(raw, MAX_PARALLEL, (i) => completeIssue(i, projectId));
  const teamIds = [...new Set(issues.map((i) => i.teamId))];
  // Issues outside the project that are linked to it by blocks relations (for example, ENG
  // tickets that wg maps as nodes). They are read-only here. Their own relations give the edges
  // between them. A wg node can be several relations away (ENG lane -> ENG lane -> CD merge
  // point), so the search continues through outside issues that have a wg node card, and stops
  // at outside issues that have none.
  const known = new Set(issues.map((i) => i.id));
  let frontier = issues;
  while (frontier.length) {
    const outside = [...new Set(frontier.flatMap((i) => [...i.blocks, ...i.blockedBy]).map((r) => r.id))].filter((id) => !known.has(id));
    outside.forEach((id) => known.add(id));
    const found: Issue[] = [];
    for (let at = 0; at < outside.length; at += 25) {
      const data = await gql(`query($ids:[ID!]){ issues(first:25,filter:{id:{in:$ids}}){ nodes{${ISSUE}} } }`, { ids: outside.slice(at, at + 25) });
      const linked = await mapLimit(data.issues.nodes as RawIssue[], MAX_PARALLEL, (i) => completeIssue(i, projectId));
      found.push(...linked.map((i) => ({ ...i, external: true })));
    }
    issues.push(...found);
    frontier = found.filter((i) => i.card);
  }
  await addReviewUrls(issues);
  let teams: Record<string, Team> = {};
  let labels: Label[] = [];
  const metaKey = `${linearWorkspace.getStore()?.id ?? site.defaultWorkspace}:${[...teamIds].sort().join(",")}`;
  const meta = metaCache.get(metaKey);
  if (meta && Date.now() - meta.at < META_MS) ({ teams, labels } = meta);
  else if (teamIds.length) {
    type RawTeam = { id: string; key: string; states: { nodes: (State & { position: number })[] }; members: { nodes: (RawUser & { active: boolean })[] } };
    const found = await gql(
      `query($ids:[ID!]){ teams(first:10,filter:{id:{in:$ids}}){ nodes{ id key
         states(first:50){nodes{id name type color position}}
         members(first:100){nodes{id name displayName avatarUrl active}} } } }`,
      { ids: teamIds },
    );
    for (const t of found.teams.nodes as RawTeam[]) {
      teams[t.id] = {
        key: t.key,
        states: t.states.nodes.sort((a, b) => a.position - b.position),
        members: t.members.nodes.filter((m) => m.active).map((m) => person(m)!).sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    type RawTeamLabel = RawLabel & { isGroup: boolean; team: { id: string } | null };
    const rawLabels = await pages<RawTeamLabel>(
      `query($ids:[ID!],$after:String){ issueLabels(first:250,after:$after,
         filter:{or:[{team:{id:{in:$ids}}},{team:{null:true}}]}){
         nodes{id name color isGroup parent{name} team{id}} pageInfo{hasNextPage endCursor} } }`,
      { ids: teamIds },
      (data) => data.issueLabels,
    );
    labels = rawLabels.filter((l) => !l.isGroup).map((l) => ({ ...label(l), teamId: l.team?.id ?? null }));
    metaCache.set(metaKey, { at: Date.now(), teams, labels });
  }
  const { id, name, url, projectMilestones, documents } = head.project as {
    id: string; name: string; url: string; projectMilestones: { nodes: Milestone[] };
    documents?: { nodes: { content: string | null; updatedAt: string }[] };
  };
  const doc = documents?.nodes[0];
  return {
    project: { id, name, url },
    milestones: projectMilestones.nodes.sort((a, b) => a.sortOrder - b.sortOrder),
    issues, teams, labels, viewerId: head.viewer.id,
    status: doc?.content ? { content: doc.content, updatedAt: doc.updatedAt } : null,
  };
}

const isProtected = (l: Label) => l.group === "agent" || l.name.startsWith("agent:") || KIND_LABELS.has(l.name);
const EDITABLE = new Set(["title", "description", "stateId", "priority", "assigneeId", "labelIds"]);

interface Writable { team: { key: string }; project: { id: string } | null; description: string | null; labels: { nodes: RawLabel[] }; comments: { nodes: { id: string }[] } }

/**
 * The issue, as far as a write needs it. Only the workspace's configured team is writable.
 * Issues with no project are included; linked ENG issues stay read-only.
 */
async function writable(issueId: string, team: string): Promise<Writable> {
  let data: Data;
  try {
    data = await gql(
      `query($id:String!){ issue(id:$id){ team{key} project{id} description labels(first:50){nodes{id name parent{name}}}
         comments(first:1, filter:{body:{startsWith:"${CARD_PREFIX}"}}){nodes{id}} } }`,
      { id: issueId },
    );
  } catch (error) {
    // Linear answers an unknown id with an error, not with an empty issue.
    if (error instanceof LinearError && /not found/i.test(error.message)) throw new LinearError(`issue ${issueId} not found`, 404);
    throw error;
  }
  const issue = data.issue as Writable | null;
  if (!issue) throw new LinearError(`issue ${issueId} not found`, 404);
  if (issue.team.key !== team) throw new LinearError(`this issue is not in team ${team}: it is read-only here`, 403);
  return issue;
}

/** The first word of the comment that records why an `ops` or `decision` node is done, as `wg move --note` writes it. */
const NOTE_WORD: Record<string, string> = { ops: "Evidence", decision: "Answer" };

/** Hears the project of the issue that a write changes (null: the issue has no project), before the write. */
export type ProjectOfWrite = (projectId: string | null) => void;

export async function updateIssue(issueId: string, { baseDescription, note, ...patch }: IssuePatch, team: string, project?: ProjectOfWrite): Promise<Issue> {
  const unknown = Object.keys(patch).filter((k) => !EDITABLE.has(k));
  if (unknown.length || !Object.keys(patch).length) {
    throw new LinearError(`fields not editable: ${unknown.join(", ") || "(none given)"}`, 400);
  }
  const current = { issue: await writable(issueId, team) };
  project?.(current.issue.project?.id ?? null);
  // `wg load` sets the title of a node from plan.json, so a title that is changed here is lost.
  if (patch.title !== undefined && current.issue.comments.nodes.length) {
    throw new LinearError("plan.json has the title of a wg node: change it there, then run `wg load --apply`", 400);
  }
  // The coordinator also writes the description. A save from an old text would remove its change.
  if (patch.description !== undefined && baseDescription !== undefined && (current.issue.description ?? "") !== baseDescription) {
    throw new LinearError("the description changed in Linear after you opened it: copy your text, cancel, and edit the new description", 409);
  }
  // wg refuses a Done ops node with no evidence. The same rule holds here, and the comment is written
  // first: if it fails, the issue does not move.
  const kind = current.issue.labels.nodes.map((l) => l.name).find((name) => name in NOTE_WORD);
  if (patch.stateId && kind) {
    const target = await gql(`query($id:String!){ workflowState(id:$id){ type } }`, { id: patch.stateId });
    if (target.workflowState?.type === "completed") {
      if (!note?.trim()) throw new LinearError(`${kind === "ops" ? "an ops" : "a decision"} node goes to a done status only with its ${NOTE_WORD[kind].toLowerCase()}`, 400);
      const made = await gql(`mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }`, { i: { issueId, body: `${NOTE_WORD[kind]}: ${note.trim()}` } });
      if (!made.commentCreate.success) throw new LinearError("Linear did not save the comment; the issue did not move");
    }
  }
  if (patch.labelIds) {
    const guarded = current.issue.labels.nodes.map(label).filter(isProtected).map((l) => l.id);
    const wanted = new Set(patch.labelIds);
    const added = await gql(`query($ids:[ID!]){ issueLabels(filter:{id:{in:$ids}}){ nodes{id name parent{name}} } }`, { ids: patch.labelIds });
    const newGuarded = (added.issueLabels.nodes as RawLabel[]).map(label).filter(isProtected).map((l) => l.id);
    if (guarded.some((id) => !wanted.has(id)) || newGuarded.some((id) => !guarded.includes(id))) {
      throw new LinearError("claim labels (agent:*) and kind labels are read-only here", 400);
    }
  }
  const data = await gql(
    `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success issue{${ISSUE}} } }`,
    { id: issueId, i: patch },
  );
  if (!data.issueUpdate.success) throw new LinearError("Linear did not apply the update");
  return completeIssue(data.issueUpdate.issue, current.issue.project?.id);
}

const COMMENT = "id body createdAt user{name displayName avatarUrl} botActor{name} parent{id}";
const comment = (c: RawComment): Comment => ({
  id: c.id, body: c.body ?? "", createdAt: c.createdAt, parentId: c.parent?.id ?? null,
  author: c.user ? c.user.displayName || c.user.name : c.botActor?.name ?? "unknown",
});

export async function listComments(issueId: string, inProject?: string): Promise<Comment[]> {
  const nodes = await pages<RawComment>(
    `query($id:String!,$after:String){ issue(id:$id){ project{id} comments(first:50,after:$after){
       nodes{${COMMENT}} pageInfo{hasNextPage endCursor} } } }`,
    { id: issueId },
    (data) => {
      // The same answer of Linear gives the project and the comments, so no older copy of the graph decides.
      if (inProject !== undefined && data.issue?.project?.id !== inProject) throw new LinearError("no issue with this id in the shared project", 404);
      return data.issue.comments;
    },
  );
  return nodes.map(comment).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addComment(issueId: string, body: unknown, team: string, project?: ProjectOfWrite): Promise<Comment> {
  if (typeof body !== "string" || !body.trim()) throw new LinearError("comment body is empty", 400);
  if (body.startsWith(CARD_PREFIX)) throw new LinearError("that text is reserved for the wg node card", 400);
  project?.((await writable(issueId, team)).project?.id ?? null);
  const data = await gql(
    `mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment{${COMMENT}} } }`,
    { i: { issueId, body } },
  );
  if (!data?.commentCreate?.success || !data.commentCreate.comment) throw new LinearError("Linear did not save the comment");
  return comment(data.commentCreate.comment);
}
