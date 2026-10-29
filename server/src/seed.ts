import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { createPool, withTransaction, type Db, type Tx } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { loadConfig } from "./config.js";
import { hashPassword } from "./auth/password.js";
import { DEFAULT_SETTINGS } from "./domain/policy.js";
import { ensureRules } from "./services/notifications.js";

export const DEMO_PASSWORD = "demo-password-1";
export const DEMO_TZ = "America/Los_Angeles";

export interface DemoIds {
  projectId: string;
  admin: string;
  supervisor: string;
  tutors: Record<"ada" | "grace" | "alan" | "katherine" | "mary", string>;
  locations: { main: string; annex: string };
  teams: { north: string; south: string };
}

/**
 * Demo/seed data for local development, demos and end-to-end tests. Historical clock events are
 * inserted directly with source = 'system' and metadata.seed = true so they are clearly synthetic.
 */
export async function seedDemo(db: Db, now: Date = new Date()): Promise<DemoIds> {
  const pw = await hashPassword(DEMO_PASSWORD);
  return withTransaction(db, async (tx) => {
    const project = await one(tx, `INSERT INTO projects (name, timezone, settings) VALUES ($1,$2,$3) RETURNING id`, [
      "Vibe Amplified Tutoring",
      DEMO_TZ,
      JSON.stringify(DEFAULT_SETTINGS),
    ]);
    await ensureRules(tx, project);
    const north = await one(tx, `INSERT INTO teams (project_id, name) VALUES ($1,'North Campus') RETURNING id`, [project]);
    const south = await one(tx, `INSERT INTO teams (project_id, name) VALUES ($1,'South Campus') RETURNING id`, [project]);
    const main = await one(tx, `INSERT INTO work_locations (project_id, name, address) VALUES ($1,'Main Learning Center','100 Learning Way') RETURNING id`, [project]);
    const annex = await one(tx, `INSERT INTO work_locations (project_id, name, address) VALUES ($1,'Library Annex','22 Library Lane') RETURNING id`, [project]);

    const person = async (email: string, name: string, role: string, team: string | null, opts: { sysadmin?: boolean; code?: string } = {}) => {
      const id = await one(
        tx,
        `INSERT INTO users (auth_subject, email, display_name, status, is_system_admin) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
        [`local|${randomUUID()}`, email, name, opts.sysadmin ?? false],
      );
      await tx.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [id, pw]);
      await tx.query(`INSERT INTO project_memberships (project_id, user_id, role, team_id) VALUES ($1,$2,$3,$4)`, [project, id, role, team]);
      if (opts.code) await tx.query(`INSERT INTO tutor_profiles (user_id, employee_code) VALUES ($1,$2)`, [id, opts.code]);
      return id;
    };
    const admin = await person("admin@example.com", "Avery Admin", "admin", null, { sysadmin: true });
    const supervisor = await person("supervisor@example.com", "Sam Supervisor", "supervisor", north);
    const tutors = {
      ada: await person("ada@example.com", "Ada Lovelace", "tutor", north, { code: "T-1001" }),
      grace: await person("grace@example.com", "Grace Hopper", "tutor", north, { code: "T-1002" }),
      alan: await person("alan@example.com", "Alan Turing", "tutor", south, { code: "T-1003" }),
      katherine: await person("katherine@example.com", "Katherine Johnson", "tutor", south, { code: "T-1004" }),
      mary: await person("mary@example.com", "Mary Jackson", "tutor", north, { code: "T-1005" }),
    };

    const local = (daysAgo: number, hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return DateTime.fromJSDate(now, { zone: DEMO_TZ }).minus({ days: daysAgo }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate();
    };
    const session = async (
      tutor: string,
      location: string | null,
      events: Array<[string, Date]>,
      state: "in" | "break" | "closed",
    ) => {
      const started = events[0]![1];
      const closed = state === "closed" ? events[events.length - 1]![1] : null;
      const sid = await one(
        tx,
        `INSERT INTO work_sessions (project_id, tutor_id, location_id, state, started_at, closed_at, settings_version)
         VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id`,
        [project, tutor, location, state, started, closed],
      );
      for (const [type, at] of events) {
        await tx.query(
          `INSERT INTO clock_events (project_id, session_id, actor_id, event_type, occurred_at, received_at, source,
                                     idempotency_key, sync_status, location_id, settings_version, metadata)
           VALUES ($1,$2,$3,$4,$5,$5,'system',$6,'accepted',$7,1,'{"seed":true}')`,
          [project, sid, tutor, type, at, randomUUID(), type === "clock_in" ? location : null],
        );
      }
      return sid;
    };

    // Two weeks of closed history on weekdays.
    for (let d = 14; d >= 1; d--) {
      const day = DateTime.fromJSDate(now, { zone: DEMO_TZ }).minus({ days: d });
      if (day.weekday > 5) continue;
      await session(tutors.ada, main, [["clock_in", local(d, "08:58")], ["break_start", local(d, "12:01")], ["break_end", local(d, "12:31")], ["clock_out", local(d, "15:04")]], "closed");
      await session(tutors.alan, annex, [["clock_in", local(d, "13:02")], ["clock_out", local(d, "17:15")]], "closed");
      if (d % 2 === 0) await session(tutors.katherine, main, [["clock_in", local(d, "09:30")], ["break_start", local(d, "11:45")], ["break_end", local(d, "12:05")], ["clock_out", local(d, "14:00")]], "closed");
      if (d !== 1 && d % 3 === 0) await session(tutors.grace, main, [["clock_in", local(d, "10:00")], ["clock_out", local(d, "16:20")]], "closed");
    }

    // Live state: one clocked in, one on break, one with a missed clock-out from yesterday.
    const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
    await session(tutors.grace, main, [["clock_in", t(150)]], "in");
    await session(tutors.katherine, annex, [["clock_in", t(200)], ["break_start", t(12)]], "break");
    const missed = await session(tutors.mary, main, [["clock_in", local(1, "09:00")]], "in");

    // A pending correction for Ada's most recent closed session.
    const { rows } = await tx.query<{ id: string; started_at: Date }>(
      `SELECT id, started_at FROM work_sessions WHERE tutor_id = $1 AND state = 'closed' ORDER BY started_at DESC LIMIT 1`,
      [tutors.ada],
    );
    if (rows[0]) {
      const corrected = DateTime.fromJSDate(rows[0].started_at, { zone: DEMO_TZ }).set({ hour: 8, minute: 30 }).toUTC().toISO();
      const change = { issue: "wrong_clock_in", clock_in_at: corrected };
      const explanation = "I started setting up the classroom at 8:30 but forgot to clock in until later.";
      const cid = await one(
        tx,
        `INSERT INTO correction_requests (project_id, session_id, requester_id, requested_change, explanation, submitted_at)
         VALUES ($1,$2,$3,$4,$5, now() - interval '3 hours') RETURNING id`,
        [project, rows[0].id, tutors.ada, JSON.stringify(change), explanation],
      );
      await tx.query(
        `INSERT INTO audit_logs (project_id, actor_id, action, target_type, target_id, after, occurred_at)
         VALUES ($1,$2,'correction.submitted','correction_request',$3,$4, now() - interval '3 hours')`,
        [project, tutors.ada, cid, JSON.stringify({ session_id: rows[0].id, requested_change: change, explanation })],
      );
    }

    // Upcoming shifts.
    await tx.query(
      `INSERT INTO shifts (project_id, tutor_id, location_id, label, scheduled_start, scheduled_end) VALUES
         ($1,$2,$3,'Morning tutoring block',$4,$5), ($1,$6,$7,'Afternoon study hall',$8,$9)`,
      [project, tutors.ada, main, local(-1, "09:00"), local(-1, "15:00"), tutors.alan, annex, local(-1, "13:00"), local(-1, "17:00")],
    );
    await tx.query(
      `INSERT INTO audit_logs (project_id, actor_id, action, target_type, target_id, after) VALUES ($1,$2,'seed.demo_data_loaded','project',$1,$3)`,
      [project, admin, JSON.stringify({ missed_clock_out_session: missed })],
    );

    return { projectId: project, admin, supervisor, tutors, locations: { main, annex }, teams: { north, south } };
  });
}

async function one(tx: Tx, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  if (config.env === "production" && !process.argv.includes("--force")) {
    console.error("Refusing to seed demo data in production (pass --force to override).");
    process.exit(1);
  }
  const db = createPool(config.databaseUrl);
  try {
    await migrate(db);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM projects`);
    if (rows[0].n > 0) {
      console.log("Database already has projects; skipping demo seed.");
    } else {
      const ids = await seedDemo(db);
      console.log(`Seeded demo project ${ids.projectId}.`);
      console.log(`Sign in with any of: admin@example.com, supervisor@example.com, ada@example.com, grace@example.com,`);
      console.log(`alan@example.com, katherine@example.com, mary@example.com — password: ${DEMO_PASSWORD}`);
    }
  } finally {
    await db.end();
  }
}
