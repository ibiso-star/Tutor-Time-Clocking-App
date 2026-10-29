import type { Queryable } from "../db/pool.js";
import type { AuthUser } from "../lib/context.js";
import { forbidden, notFound } from "../lib/errors.js";
import { parseSettings, type ProjectSettings } from "../domain/policy.js";

export type Role = "tutor" | "supervisor" | "admin";
const RANK: Record<Role, number> = { tutor: 1, supervisor: 2, admin: 3 };

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  timezone: string;
  settings: ProjectSettings;
  settings_version: number;
  retention_days: number | null;
  updated_at: Date;
}

export interface ProjectScope {
  project: ProjectRow;
  role: Role;
  /** When set, a supervisor sees only tutors in this team. */
  teamId: string | null;
  userId: string;
}

export async function loadProject(q: Queryable, projectId: string): Promise<ProjectRow> {
  const { rows } = await q.query(
    `SELECT id, name, status, timezone, settings, settings_version, retention_days, updated_at
       FROM projects WHERE id = $1`,
    [projectId],
  );
  if (!rows[0]) throw notFound("Project not found.");
  return { ...rows[0], settings: parseSettings(rows[0].settings) };
}

/**
 * Server-side authorization: resolves the caller's active membership in a project and enforces a
 * minimum role. Client-supplied roles are never trusted.
 */
export async function requireProjectRole(
  q: Queryable,
  user: AuthUser,
  projectId: string,
  minRole: Role,
): Promise<ProjectScope> {
  if (!isUuid(projectId)) throw notFound("Project not found.");
  const { rows } = await q.query<{ role: Role; team_id: string | null }>(
    `SELECT role, team_id FROM project_memberships
      WHERE project_id = $1 AND user_id = $2 AND active_to IS NULL`,
    [projectId, user.id],
  );
  const membership = rows[0];
  if (user.is_system_admin) {
    const project = await loadProject(q, projectId);
    return { project, role: "admin", teamId: null, userId: user.id };
  }
  if (!membership) throw forbidden("You are not a member of this project.");
  if (RANK[membership.role] < RANK[minRole]) throw forbidden();
  const project = await loadProject(q, projectId);
  return {
    project,
    role: membership.role,
    teamId: membership.role === "supervisor" ? membership.team_id : null,
    userId: user.id,
  };
}

/** Throws unless the scoped reviewer may see this tutor (team scoping for supervisors). */
export async function assertTutorInScope(q: Queryable, scope: ProjectScope, tutorId: string): Promise<void> {
  const { rows } = await q.query<{ team_id: string | null }>(
    `SELECT team_id FROM project_memberships WHERE project_id = $1 AND user_id = $2
      ORDER BY active_to IS NULL DESC, active_from DESC LIMIT 1`,
    [scope.project.id, tutorId],
  );
  if (!rows[0]) throw notFound("Tutor not found in this project.");
  if (scope.teamId && rows[0].team_id !== scope.teamId) throw forbidden("This tutor is outside your team.");
}

/**
 * SQL fragment limiting a tutor id column to the scope's team. Returns "TRUE" when unscoped.
 * `param` is the first free positional parameter index; returned params fill $param and $param+1.
 * `tutorColumn` must be a trusted column reference, never user input.
 */
export function teamFilterSql(scope: ProjectScope, tutorColumn: string, param: number): { sql: string; params: unknown[] } {
  if (!scope.teamId) return { sql: "TRUE", params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM project_memberships tm WHERE tm.project_id = $${param}
                   AND tm.user_id = ${tutorColumn} AND tm.team_id = $${param + 1} AND tm.active_to IS NULL)`,
    params: [scope.project.id, scope.teamId],
  };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
