import { lockProjectActor, type ClaimScope } from "./claims.ts";
import type { Sql } from "./sql.ts";

export type PlanData = { plan: Record<string, unknown>; keymap: Record<string, unknown> };
type Revision = { version: number; writer: string | null; writtenAt: Date };

const onProject = "p.tenant_id = $1 AND p.connection_id = $2 AND p.project_id = $3";
const revisions = `FROM project_plans p LEFT JOIN users u ON u.id = p.writer_user_id WHERE ${onProject}`;
const historyColumns = 'p.version, u.name AS writer, p.written_at AS "writtenAt"';

type Operation = { kind: "get"; version?: number } | { kind: "list" }
  | { kind: "put"; match?: string[]; initialize: boolean; data: PlanData };

export function createPlans(sql: Sql) {
  return (scope: ClaimScope, operation: Operation) => sql.transaction(async ({ query }) => {
    const { project } = scope;
    const actor = await lockProjectActor(query, scope);
    if (!actor?.role) return { status: 404 } as const;
    const { role } = actor;

    if (operation.kind === "list") {
      const versions = await query<Revision>(
        `SELECT ${historyColumns} ${revisions} ORDER BY p.version DESC LIMIT 50`, project);
      return { status: 200, versions } as const;
    }
    if (operation.kind === "get") {
      if (operation.version !== undefined && role === "viewer") return { status: 403 } as const;
      const [plan] = await query<PlanData & { version: number }>(`
        SELECT p.version, p.plan, p.keymap FROM project_plans p WHERE ${onProject}
          ${operation.version === undefined ? "" : "AND p.version = $4"}
        ORDER BY p.version DESC LIMIT 1`, operation.version === undefined ? project : [...project, operation.version]);
      return plan ? { status: 200, plan } as const : { status: 404 } as const;
    }
    if (role === "viewer") return { status: 403 } as const;

    // The tenant lock also protects the empty history. Read the latest version
    // in a separate statement after acquiring it so the snapshot sees its writer.
    const [current] = await query<Revision>(
      `SELECT ${historyColumns} ${revisions} ORDER BY p.version DESC LIMIT 1 FOR UPDATE OF p`, project);
    if (!current && role !== "owner") return { status: 403 } as const;
    if (current ? !operation.match?.includes(String(current.version)) || operation.initialize : !operation.initialize || operation.match !== undefined) {
      return { status: 412, version: current?.version ?? null, writer: current?.writer ?? null, role } as const;
    }

    const version = (current?.version ?? 0) + 1;
    const { data } = operation;
    await query(`INSERT INTO project_plans (tenant_id, connection_id, project_id, version, plan, keymap, writer_user_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [...project, version, JSON.stringify(data.plan), JSON.stringify(data.keymap), actor.id]);
    if (version > 50) {
      await query(`DELETE FROM project_plans p WHERE ${onProject} AND p.version <= $4`, [...project, version - 50]);
    }
    return { status: 200, version, role } as const;
  });
}
