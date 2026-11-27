import { randomBytes, randomUUID } from "node:crypto";
import { tokenHash } from "./crypto.ts";
import type { Query, Sql } from "./sql.ts";

export const SHARE_KINDS = ["view", "collab"] as const;
export type ShareKind = typeof SHARE_KINDS[number];
export type MemberRole = "viewer" | "collaborator";
export const MAX_PROJECT_MEMBERS = 50;

type ProjectScope = [tenant: string, connection: string, project: string];
export type LinearIdentity = { email: string; linearUserId: string; linearOrgId: string };
const scope = "tenant_id = $1 AND connection_id = $2 AND project_id = $3";
const live = "revoked_at IS NULL";
type Share = { id: string; tenant: string; connection: string; project: string; name: string; kind: ShareKind };
const roleFor = (kind: ShareKind): MemberRole => kind === "view" ? "viewer" : "collaborator";
type Member = { id: string; name: string; email: string; role: MemberRole; joinedAt: Date; accessRequestedAt: Date | null };

export function createShares(sql: Sql, notify: (tenant: string, membersOnly?: boolean) => Promise<void>) {
  async function lock(query: Query, tenant: string) {
    const [row] = await query<{ owner: string }>("SELECT owner_user_id AS owner FROM tenants WHERE id = $1 FOR NO KEY UPDATE", [tenant]);
    return row?.owner;
  }

  async function liveLinks(query: Query, project: ProjectScope) {
    return query<{ kind: ShareKind; createdAt: Date }>(
      `SELECT kind, created_at AS "createdAt" FROM shares WHERE ${scope} AND ${live}`, project);
  }

  async function revoke(query: Query, project: ProjectScope, kind: ShareKind) {
    const rows = await query(`UPDATE shares SET revoked_at = now() WHERE ${scope} AND kind = $4 AND ${live} RETURNING id`, [...project, kind]);
    return rows.length > 0;
  }

  async function find(query: Query, hash: string) {
    const [row] = await query<Share>(`SELECT id, tenant_id AS tenant, connection_id AS connection,
      project_id AS project, project_name AS name, kind FROM shares WHERE token_hash = $1 AND ${live}`, [hash]);
    return row;
  }

  async function changeMemberWithClaims(project: ProjectScope, member: string, role?: MemberRole) {
    const released = await sql.transaction(async ({ query }) => {
      if (!await lock(query, project[0])) return null;
      const rows = role
        ? await query(`UPDATE project_members SET role = $5, access_requested_at = CASE WHEN $5 = 'viewer' THEN NULL ELSE access_requested_at END WHERE ${scope} AND user_id = $4 RETURNING user_id`, [...project, member, role])
        : await query(`DELETE FROM project_members WHERE ${scope} AND user_id = $4 RETURNING user_id`, [...project, member]);
      if (!rows.length) return null;
      if (role === "collaborator") return [];
      const deleted = await query<{ node: string }>(
        `DELETE FROM node_claims WHERE ${scope} AND holder_user_id = $4 RETURNING node_key AS node`, [...project, member]);
      return deleted.map(({ node }) => node).sort();
    });
    if (released) await notify(project[0], true);
    return released;
  }

  return {
    async waitNames(project: ProjectScope): Promise<string[] | undefined> {
      const rows = await sql.query<{ owner: string; collaborator: string | null }>(`
        SELECT owner.human AS owner, runner.human AS collaborator
        FROM project_members m
        JOIN tenants owner ON owner.id = m.tenant_id
        LEFT JOIN tenants runner ON runner.owner_user_id = m.user_id AND m.role = 'collaborator'
        WHERE m.tenant_id = $1 AND m.connection_id = $2 AND m.project_id = $3
        ORDER BY m.joined_at, m.id`, project);
      if (!rows.length) return;
      return [...new Set([rows[0].owner, ...rows.flatMap(({ collaborator }) => collaborator ? [collaborator] : [])])];
    },

    memberships(account: string) {
      return sql.query<{ id: string; ownerId: string; connectionId: string; projectId: string; name: string; role: MemberRole }>(`
        SELECT m.id, m.tenant_id AS "ownerId", m.connection_id AS "connectionId",
          m.project_id AS "projectId", s.project_name AS name, m.role
        FROM project_members m
        JOIN tenants t ON t.owner_user_id = m.user_id
        JOIN shares s ON s.id = m.share_id
        WHERE t.id = $1
        ORDER BY s.project_name, m.id`, [account]);
    },

    async list(project: ProjectScope) {
      const links = await liveLinks(sql.query, project);
      const members = await sql.query<Member>(`SELECT u.id, u.name, u.email, m.role, m.joined_at AS "joinedAt",
        m.access_requested_at AS "accessRequestedAt"
        FROM project_members m JOIN users u ON u.id = m.user_id WHERE ${scope}
        ORDER BY m.joined_at, u.id`, project);
      // A revoked project can still have members to manage.
      const known = links.length || members.length || (await sql.query(`SELECT 1 FROM shares WHERE ${scope} LIMIT 1`, project)).length;
      return known ? { links, members } : null;
    },

    async accessMember(project: ProjectScope, member: string) {
      const [row] = await sql.query<LinearIdentity & { role: MemberRole }>(`
        SELECT m.role, u.email, u.linear_user_id AS "linearUserId", u.linear_org_id AS "linearOrgId" FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE ${scope} AND m.user_id = $4`, [...project, member]);
      return row;
    },

    async reserveAccessInvite(project: ProjectScope, member: string) {
      const [row] = await sql.query<{ attempt: string }>(`UPDATE project_members SET access_invited_at = now()
        WHERE ${scope} AND user_id = $4 AND role = 'collaborator'
        AND (access_invited_at IS NULL OR access_invited_at <= now() - interval '10 minutes')
        RETURNING access_invited_at::text AS attempt`, [...project, member]);
      return row?.attempt;
    },

    async releaseAccessInvite(project: ProjectScope, member: string, attempt: string) {
      await sql.query(`UPDATE project_members SET access_invited_at = NULL
        WHERE ${scope} AND user_id = $4 AND access_invited_at = $5`, [...project, member, attempt]);
    },

    async requestAccess(project: ProjectScope, membership: string) {
      const rows = await sql.query(`UPDATE project_members
        SET access_requested_at = now(), access_request_limit_until = now() + interval '10 minutes'
        WHERE ${scope} AND id = $4 AND role = 'collaborator'
        AND (access_request_limit_until IS NULL OR access_request_limit_until <= now()) RETURNING id`, [...project, membership]);
      if (rows.length) return "requested";
      const [row] = await sql.query(`SELECT id FROM project_members
        WHERE ${scope} AND id = $4 AND role = 'collaborator'`, [...project, membership]);
      return row ? "limited" : "missing";
    },

    async accessRequestedAt(project: ProjectScope, membership: string) {
      const [row] = await sql.query<{ at: string | null }>(`SELECT access_requested_at AS at FROM project_members
        WHERE ${scope} AND id = $4 AND role = 'collaborator'`, [...project, membership]);
      return row?.at ?? null;
    },

    async clearAccessRequest(project: ProjectScope, membership: string) {
      await sql.query(`UPDATE project_members SET access_requested_at = NULL
        WHERE ${scope} AND id = $4 AND access_requested_at IS NOT NULL`, [...project, membership]);
    },

    async make(project: ProjectScope, name: string, selection?: { kind: ShareKind; rotate?: true }) {
      const [tenant, connection] = project;
      const result = await sql.transaction(async ({ query }) => {
        const owner = await lock(query, tenant);
        // Only the sign-in workspace can be shared: an attached workspace stays private to its owner.
        if (!owner || !(await query(`SELECT 1 FROM linear_connections c JOIN tenants t ON t.id = c.tenant_id
          JOIN users u ON u.id = t.owner_user_id WHERE c.tenant_id = $1 AND c.id = $2 AND c.kind = 'oauth'
          AND c.linear_org_id = u.linear_org_id`, [tenant, connection])).length) return null;
        const links = await liveLinks(query, project);
        const created: Partial<Record<ShareKind, string>> = {};
        const revoked = selection?.rotate ? await revoke(query, project, selection.kind) : false;
        for (const kind of selection ? [selection.kind] : SHARE_KINDS) {
          if (!selection?.rotate && links.some((link) => link.kind === kind)) continue;
          const token = randomBytes(32).toString("base64url");
          await query(`INSERT INTO shares (id, tenant_id, connection_id, project_id, project_name, kind, token_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), ...project, name, kind, tokenHash(token)]);
          created[kind] = token;
        }
        return { created, revoked };
      });
      if (result && Object.keys(result.created).length) await notify(tenant, true);
      return result;
    },

    async revoke(project: ProjectScope, kind: ShareKind) {
      const changed = await sql.transaction(async ({ query }) =>
        !!await lock(query, project[0]) && revoke(query, project, kind));
      if (changed) await notify(project[0], true);
      return changed;
    },

    changeMemberWithClaims,
    async changeMember(project: ProjectScope, member: string, role?: MemberRole) {
      return (await changeMemberWithClaims(project, member, role)) !== null;
    },

    async preview(token: string) {
      const [row] = await sql.query<{ project: string; owner: string; kind: ShareKind }>(`
        SELECT s.project_name AS project, t.human AS owner, s.kind FROM shares s
        JOIN tenants t ON t.id = s.tenant_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL`, [tokenHash(token)]);
      return row ? { project: row.project, owner: row.owner, role: roleFor(row.kind) } : null;
    },

    async join(account: string, token: string) {
      const hash = tokenHash(token);
      const result = await sql.transaction(async ({ query }) => {
        const candidate = await find(query, hash);
        if (!candidate) return null;
        const owner = await lock(query, candidate.tenant);
        const share = owner && await find(query, hash);
        if (!share) return null;
        const [member] = await query<{ id: string }>(`SELECT u.id FROM tenants t JOIN users u ON u.id = t.owner_user_id
          WHERE t.id = $1 FOR KEY SHARE OF u`, [account]);
        if (!member) return null;
        const project = share.name;
        const role = roleFor(share.kind);
        if (member.id === owner) return { share, project, role, changed: false } as const;
        const params: ProjectScope = [share.tenant, share.connection, share.project];
        const [prior] = await query<{ role: MemberRole }>(`SELECT role FROM project_members
          WHERE ${scope} AND user_id = $4`, [...params, member.id]);
        if (prior && (prior.role === "collaborator" || prior.role === role)) {
          return { share, project, role: prior.role, changed: false } as const;
        }
        if (!prior) {
          const [count] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM project_members WHERE ${scope}`, params);
          if (count.count >= MAX_PROJECT_MEMBERS) return "full" as const;
        }
        await query(`INSERT INTO project_members (tenant_id, connection_id, project_id, user_id, role, share_id)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, connection_id, project_id, user_id)
          DO UPDATE SET role = EXCLUDED.role, share_id = EXCLUDED.share_id`, [...params, member.id, role, share.id]);
        return { share, project, role, changed: true } as const;
      });
      if (result && result !== "full" && result.changed) {
        await Promise.all([notify(result.share.tenant, true), notify(account, true)]);
      }
      return result;
    },
  };
}
