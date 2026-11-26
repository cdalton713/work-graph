import type { Sql } from "./sql.ts";

export const claimJobs = ["dispatch", "review", "ci", "threads", "restack"] as const;
export type ClaimJob = typeof claimJobs[number];

type Role = "owner" | "collaborator" | "viewer";
export type ClaimScope = {
  project: [tenant: string, connection: string, project: string];
  account: string;
  membership?: string;
};

type Claim = {
  node: string;
  job: ClaimJob;
  holder: string;
  claimedAt: Date;
  renewedAt: Date;
  leaseUntil: Date;
  stale: boolean;
};

const onProject = "c.tenant_id = $1 AND c.connection_id = $2 AND c.project_id = $3";
const columns = `c.node_key AS node, c.job, u.name AS holder, c.claimed_at AS "claimedAt",
  c.renewed_at AS "renewedAt", c.lease_until AS "leaseUntil", c.lease_until <= now() AS stale`;

type Operation = { kind: "list" } | { kind: "release"; node: string }
  | { kind: "post"; node: string; job: ClaimJob; lease: number }
  | { kind: "put"; node: string; lease: number };

export function createClaims(sql: Sql) {
  return (scope: ClaimScope, operation: Operation) => sql.transaction(async ({ query }) => {
    const { project, account, membership } = scope;
    // The member routes take the same lock. This serializes the live limit and prevents
    // a former collaborator from inserting a claim after the member change commits.
    const [owner] = await query<{ id: string }>(`
      SELECT t.owner_user_id AS id FROM tenants t JOIN linear_connections l ON l.tenant_id = t.id
      WHERE t.id = $1 AND l.id = $2 FOR NO KEY UPDATE OF t`, project.slice(0, 2));
    if (!owner) return { status: 404 } as const;
    const [actor] = await query<{ id: string; role: Role | null }>(`
      SELECT t.owner_user_id AS id, CASE WHEN t.id = $1 AND $5::uuid IS NULL THEN 'owner' ELSE m.role END AS role
      FROM tenants t LEFT JOIN project_members m ON m.user_id = t.owner_user_id AND m.id = $5
        AND m.tenant_id = $1 AND m.connection_id = $2 AND m.project_id = $3
      WHERE t.id = $4`, [...project, account, membership ?? null]);
    if (!actor?.role) return { status: 404 } as const;
    const { id, role } = actor;
    if (operation.kind === "list") {
      const claims = await query<Claim>(`SELECT ${columns}
        FROM node_claims c JOIN users u ON u.id = c.holder_user_id WHERE ${onProject} ORDER BY c.node_key`, project);
      return { status: 200, claims } as const;
    }
    if (role === "viewer") return { status: 403 } as const;
    const node = [...project, operation.node];
    if (operation.kind === "release") {
      const removed = await query(`DELETE FROM node_claims c WHERE ${onProject} AND c.node_key = $4
        AND (c.holder_user_id = $5 OR $6 = 'owner') RETURNING 1`, [...node, id, role]);
      if (removed.length) return { status: 204 } as const;
    } else {
      const written = await query<Claim & { action: "claimed" | "renewed" | "taken_over" }>(`
        WITH prior AS (
          SELECT holder_user_id, job, lease_until FROM node_claims c WHERE ${onProject} AND node_key = $4
        ), written AS (
          INSERT INTO node_claims AS c (tenant_id, connection_id, project_id, node_key, holder_user_id, job, lease_until)
          SELECT $1, $2, $3, $4, $5, COALESCE($7, (SELECT job FROM prior)), now() + $6::int * interval '1 second'
          WHERE ($7::text IS NOT NULL OR EXISTS (SELECT 1 FROM prior WHERE holder_user_id = $5))
            AND (EXISTS (SELECT 1 FROM prior WHERE lease_until > now())
              OR (SELECT count(*) FROM node_claims c WHERE ${onProject} AND lease_until > now()) < 200)
          ON CONFLICT (tenant_id, connection_id, project_id, node_key) DO UPDATE SET
            holder_user_id = EXCLUDED.holder_user_id,
            job = CASE WHEN c.holder_user_id = EXCLUDED.holder_user_id THEN c.job ELSE EXCLUDED.job END,
            claimed_at = CASE WHEN c.holder_user_id = EXCLUDED.holder_user_id THEN c.claimed_at ELSE now() END,
            renewed_at = now(), lease_until = EXCLUDED.lease_until
          WHERE c.holder_user_id = EXCLUDED.holder_user_id OR ($7 IS NOT NULL AND c.lease_until <= now())
          RETURNING c.*
        )
        SELECT ${columns}, CASE
          WHEN NOT EXISTS (SELECT 1 FROM prior) THEN 'claimed'
          WHEN EXISTS (SELECT 1 FROM prior WHERE holder_user_id = $5) THEN 'renewed'
          ELSE 'taken_over' END AS action
        FROM written c JOIN users u ON u.id = c.holder_user_id`,
      [...node, id, operation.lease, operation.kind === "post" ? operation.job : null]);
      if (written.length) {
        const [{ action, ...claim }] = written;
        return { status: 200, claim, action, role } as const;
      }
    }
    const [current] = await query<Claim & { mine: boolean }>(`SELECT ${columns}, c.holder_user_id = $5 AS mine
      FROM node_claims c JOIN users u ON u.id = c.holder_user_id WHERE ${onProject} AND c.node_key = $4`, [...node, id]);
    if (operation.kind === "release") return { status: current ? 403 : 404 } as const;
    if (current && !current.mine && (operation.kind === "put" || !current.stale)) {
      const { mine: _, ...claim } = current;
      return { status: 409, claim, role } as const;
    }
    if (operation.kind === "put" && !current) return { status: 404 } as const;
    return { status: 409 } as const;
  });
}
