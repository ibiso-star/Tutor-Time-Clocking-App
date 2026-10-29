import type { Db, Queryable } from "../db/pool.js";
import { calculateSession, sessionFlags } from "../domain/calc.js";
import { parseSettings } from "../domain/policy.js";
import { loadBundles, loadSessionRows } from "./sessions.js";

export type RuleType = "long_session" | "missed_clock_out" | "correction_submitted" | "correction_decided";

export async function ensureRules(q: Queryable, projectId: string): Promise<void> {
  await q.query(
    `INSERT INTO notification_rules (project_id, event_type)
     SELECT $1, t FROM unnest(ARRAY['long_session','missed_clock_out','correction_submitted','correction_decided']) AS t
     ON CONFLICT (project_id, event_type) DO NOTHING`,
    [projectId],
  );
}

/**
 * Queues an in-app notification per recipient. The dedupe key makes delivery idempotent: a rule
 * firing repeatedly for the same target and window produces exactly one notification.
 */
export async function notify(
  q: Queryable,
  input: {
    projectId: string;
    rule: RuleType;
    recipientIds: string[];
    dedupeKey: string;
    relatedEntityId: string | null;
    title: string;
    body: string;
  },
): Promise<number> {
  if (input.recipientIds.length === 0) return 0;
  await ensureRules(q, input.projectId);
  const { rows: rules } = await q.query<{ id: string; enabled: boolean }>(
    `SELECT id, enabled FROM notification_rules WHERE project_id = $1 AND event_type = $2`,
    [input.projectId, input.rule],
  );
  const rule = rules[0];
  if (!rule?.enabled) return 0;
  // In-app is the only channel in this release, so delivery completes on insert.
  const { rowCount } = await q.query(
    `INSERT INTO notification_deliveries (rule_id, project_id, recipient_id, dedupe_key, related_entity_id, channel,
                                          title, body, status, attempt_count, sent_at)
     SELECT $1, $2, r, $3 || ':' || r::text, $4, 'in_app', $5, $6, 'delivered', 1, now()
       FROM unnest($7::uuid[]) AS r
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [rule.id, input.projectId, input.dedupeKey, input.relatedEntityId, input.title, input.body, input.recipientIds],
  );
  return rowCount ?? 0;
}

/** Supervisors/admins who can see a given tutor (team-scoped supervisors only see their team). */
export async function reviewersFor(q: Queryable, projectId: string, tutorId: string): Promise<string[]> {
  const { rows } = await q.query<{ user_id: string }>(
    `SELECT m.user_id FROM project_memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.project_id = $1 AND m.active_to IS NULL AND m.role IN ('supervisor','admin')
        AND (m.role = 'admin' OR m.team_id IS NULL OR m.team_id = (
              SELECT team_id FROM project_memberships WHERE project_id = $1 AND user_id = $2 AND active_to IS NULL))`,
    [projectId, tutorId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Scans open sessions and raises long-session / missed-clock-out alerts. Safe to run repeatedly
 * and from multiple workers: dedupe keys guarantee one alert per session, rule and recipient.
 * Sessions are never auto-closed (PRD §8).
 */
export async function runAlertSweep(db: Db, now: Date = new Date()): Promise<number> {
  const { rows: projects } = await db.query<{ id: string; timezone: string; settings: unknown }>(
    `SELECT id, timezone, settings FROM projects WHERE status = 'active'`,
  );
  let created = 0;
  for (const p of projects) {
    const settings = parseSettings(p.settings);
    const sessions = await loadSessionRows(db, `s.project_id = $1 AND s.state IN ('in','break')`, [p.id]);
    const bundles = await loadBundles(db, sessions);
    for (const b of bundles) {
      const calc = calculateSession(b.events, b.adjustments, now);
      const flags = sessionFlags(calc, settings, p.timezone, now);
      for (const flag of flags) {
        if (flag.code !== "long_session" && flag.code !== "missed_clock_out") continue;
        if (!settings.alerts[flag.code]) continue;
        const recipients = await reviewersFor(db, p.id, b.session.tutor_id);
        created += await notify(db, {
          projectId: p.id,
          rule: flag.code,
          recipientIds: recipients,
          dedupeKey: `${flag.code}:${b.session.id}`,
          relatedEntityId: b.session.id,
          title: flag.code === "long_session" ? `Long session: ${b.session.tutor_name}` : `Possible missed clock-out: ${b.session.tutor_name}`,
          body: flag.label,
        });
      }
    }
  }
  return created;
}

export function startAlertWorker(db: Db, log: { error: (o: unknown, msg: string) => void }, intervalMs = 60_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAlertSweep(db);
    } catch (err) {
      log.error({ err }, "alert sweep failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
