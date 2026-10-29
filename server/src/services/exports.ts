import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Db, Queryable } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import type { AuditContext, AuthUser } from "../lib/context.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { describeRounding, timezoneSchema, type RoundingPolicy } from "../domain/policy.js";
import { toCsv } from "../domain/csv.js";
import { isIsoDate, localDate, localDateRange } from "../domain/time.js";
import { requireProjectRole, teamFilterSql, type ProjectScope } from "./access.js";
import { writeAudit } from "./audit.js";
import { loadBundles, loadSessionRows, toSessionDto } from "./sessions.js";

export const MAX_EXPORT_DAYS = 93;
const EXPORT_TTL_DAYS = 7;

export const exportInputSchema = z
  .object({
    project_id: z.uuid(),
    format: z.enum(["csv", "pdf"]),
    from: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date."),
    to: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date."),
    timezone: timezoneSchema.optional(),
    tutor_ids: z.array(z.uuid()).max(500).nullish(),
    group_by: z.enum(["session", "tutor_day"]).default("session"),
  })
  .refine((v) => v.from <= v.to, { message: "Start date must be on or before end date.", path: ["to"] });
export type ExportInput = z.infer<typeof exportInputSchema>;

export interface ExportRow {
  session_id: string;
  tutor_id: string;
  tutor_name: string;
  tutor_email: string;
  employee_code: string | null;
  local_date: string;
  start_local: string;
  end_local: string | null;
  break_minutes: number;
  raw_minutes: number;
  effective_seconds: number;
  effective_minutes: number;
  rounded_minutes: number;
  status: "closed" | "open" | "voided";
  adjusted: boolean;
  location: string | null;
}

export interface ExportDataset {
  rows: ExportRow[];
  totals: { sessions: number; open_sessions_excluded: number; effective_seconds: number; rounded_minutes: number };
  record_version: string;
  timezone: string;
  rounding: RoundingPolicy;
}

function dayCount(from: string, to: string) {
  return DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days + 1;
}

/**
 * Builds the canonical export dataset. Sessions are attributed to the local date (in the export
 * timezone) of their effective start. Open sessions are listed but excluded from totals because
 * their time is not final. Rounding is applied per session from the project policy.
 */
export async function buildDataset(q: Queryable, scope: ProjectScope, input: ExportInput, now: Date): Promise<ExportDataset> {
  if (dayCount(input.from, input.to) > MAX_EXPORT_DAYS) {
    throw badRequest("RANGE_TOO_LARGE", `Choose a range of ${MAX_EXPORT_DAYS} days or fewer.`);
  }
  const tz = input.timezone ?? scope.project.timezone;
  const range = localDateRange(input.from, input.to, tz);
  const team = teamFilterSql(scope, "s.tutor_id", 5);
  // Pad the query window by a day each side: adjustments can move a session's effective start.
  const sessions = await loadSessionRows(
    q,
    `s.project_id = $1 AND s.started_at >= $2::timestamptz - interval '1 day' AND s.started_at < $3::timestamptz + interval '1 day'
       AND ($4::uuid[] IS NULL OR s.tutor_id = ANY($4::uuid[])) AND ${team.sql}`,
    [scope.project.id, range.start, range.end, input.tutor_ids?.length ? input.tutor_ids : null, ...team.params],
    "ORDER BY u.display_name, s.started_at",
  );
  const bundles = await loadBundles(q, sessions);
  const { rows: profiles } = await q.query<{ user_id: string; employee_code: string | null }>(
    `SELECT user_id, employee_code FROM tutor_profiles WHERE user_id = ANY($1::uuid[])`,
    [[...new Set(sessions.map((s) => s.tutor_id))]],
  );
  const codes = new Map(profiles.map((p) => [p.user_id, p.employee_code]));
  const fmt = (iso: string | null) => (iso ? DateTime.fromISO(iso, { zone: tz }).toFormat("yyyy-LL-dd HH:mm:ss ZZZZ") : null);

  const rows: ExportRow[] = [];
  const versionHash = createHash("sha256");
  for (const b of bundles) {
    const dto = toSessionDto(b, scope.project, now);
    const date = localDate(new Date(dto.effective.start), tz);
    if (date < input.from || date > input.to) continue;
    versionHash.update(`${b.session.id}:${b.session.version}:${b.events.length}:${b.adjustments.map((a) => a.id).join(",")};`);
    const open = dto.state !== "closed";
    rows.push({
      session_id: dto.id,
      tutor_id: dto.tutor.id,
      tutor_name: dto.tutor.name,
      tutor_email: dto.tutor.email,
      employee_code: codes.get(dto.tutor.id) ?? null,
      local_date: date,
      start_local: fmt(dto.effective.start)!,
      end_local: fmt(dto.effective.end),
      break_minutes: Math.round((dto.raw.break_seconds / 60) * 100) / 100,
      raw_minutes: Math.round((dto.raw.work_seconds / 60) * 100) / 100,
      effective_seconds: open ? 0 : dto.effective.work_seconds,
      effective_minutes: open ? 0 : Math.round((dto.effective.work_seconds / 60) * 100) / 100,
      rounded_minutes: open ? 0 : dto.rounded_minutes,
      status: open ? "open" : dto.effective.voided ? "voided" : "closed",
      adjusted: dto.effective.adjusted,
      location: dto.location?.name ?? null,
    });
  }
  const counted = rows.filter((r) => r.status !== "open");
  return {
    rows,
    totals: {
      sessions: counted.length,
      open_sessions_excluded: rows.length - counted.length,
      effective_seconds: counted.reduce((s, r) => s + r.effective_seconds, 0),
      rounded_minutes: Math.round(counted.reduce((s, r) => s + r.rounded_minutes, 0) * 100) / 100,
    },
    record_version: versionHash.digest("hex").slice(0, 16),
    timezone: tz,
    rounding: scope.project.settings.rounding,
  };
}

interface DayRow {
  tutor_name: string;
  tutor_email: string;
  employee_code: string | null;
  local_date: string;
  sessions: number;
  effective_minutes: number;
  rounded_minutes: number;
  open_sessions: number;
}

function groupByTutorDay(rows: ExportRow[]): DayRow[] {
  const map = new Map<string, DayRow>();
  for (const r of rows) {
    const key = `${r.tutor_id}|${r.local_date}`;
    const d = map.get(key) ?? {
      tutor_name: r.tutor_name,
      tutor_email: r.tutor_email,
      employee_code: r.employee_code,
      local_date: r.local_date,
      sessions: 0,
      effective_minutes: 0,
      rounded_minutes: 0,
      open_sessions: 0,
    };
    if (r.status === "open") d.open_sessions += 1;
    else {
      d.sessions += 1;
      d.effective_minutes = Math.round((d.effective_minutes + r.effective_seconds / 60) * 100) / 100;
      d.rounded_minutes = Math.round((d.rounded_minutes + r.rounded_minutes) * 100) / 100;
    }
    map.set(key, d);
  }
  return [...map.values()];
}

export function renderCsv(ds: ExportDataset, groupBy: ExportInput["group_by"]): string {
  const rule = describeRounding(ds.rounding);
  if (groupBy === "tutor_day") {
    return toCsv(
      ["tutor_name", "tutor_email", "employee_code", "date", "sessions", "open_sessions_excluded", "exact_minutes", "rounded_minutes", "rounding_rule", "timezone", "record_version"],
      groupByTutorDay(ds.rows).map((d) => [
        d.tutor_name, d.tutor_email, d.employee_code, d.local_date, d.sessions, d.open_sessions,
        d.effective_minutes, d.rounded_minutes, rule, ds.timezone, ds.record_version,
      ]),
    );
  }
  return toCsv(
    ["tutor_name", "tutor_email", "employee_code", "date", "start", "end", "break_minutes", "raw_minutes", "exact_minutes", "rounded_minutes", "status", "adjusted", "location", "rounding_rule", "timezone", "session_id", "record_version"],
    ds.rows.map((r) => [
      r.tutor_name, r.tutor_email, r.employee_code, r.local_date, r.start_local, r.end_local ?? "", r.break_minutes,
      r.raw_minutes, r.effective_minutes, r.rounded_minutes, r.status, r.adjusted ? "yes" : "no", r.location ?? "",
      rule, ds.timezone, r.session_id, ds.record_version,
    ]),
  );
}

export function renderPdf(
  ds: ExportDataset,
  meta: { projectName: string; from: string; to: string; exportId: string; generatedBy: string; generatedAt: Date },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Timesheet ${meta.from} to ${meta.to}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const hm = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
    doc.fontSize(16).text(`Timesheet — ${meta.projectName}`);
    doc.moveDown(0.3).fontSize(9).fillColor("#333");
    doc.text(`Period: ${meta.from} to ${meta.to}   Timezone: ${ds.timezone}   Rounding: ${describeRounding(ds.rounding)}`);
    doc.text(`Generated ${DateTime.fromJSDate(meta.generatedAt).toUTC().toISO()} by ${meta.generatedBy}`);
    doc.text(`Export ${meta.exportId}   Record version ${ds.record_version}`);
    doc.text("Open sessions are listed but excluded from totals until they are closed.");
    doc.moveDown(0.8).fillColor("#000");

    const cols = [
      { h: "Date", w: 62 }, { h: "Start", w: 62 }, { h: "End", w: 62 }, { h: "Break", w: 46 },
      { h: "Exact", w: 56 }, { h: "Rounded", w: 56 }, { h: "Status", w: 60 }, { h: "Location", w: 111 },
    ];
    const header = () => {
      doc.fontSize(8).font("Helvetica-Bold");
      let x = 40;
      const y = doc.y;
      for (const c of cols) {
        doc.text(c.h, x, y, { width: c.w });
        x += c.w;
      }
      doc.font("Helvetica").moveDown(0.4);
    };
    const byTutor = new Map<string, ExportRow[]>();
    for (const r of ds.rows) byTutor.set(r.tutor_id, [...(byTutor.get(r.tutor_id) ?? []), r]);
    for (const rows of byTutor.values()) {
      if (doc.y > 720) doc.addPage();
      const first = rows[0]!;
      doc.fontSize(11).font("Helvetica-Bold").text(`${first.tutor_name}${first.employee_code ? ` (${first.employee_code})` : ""}`, 40);
      doc.font("Helvetica").moveDown(0.2);
      header();
      for (const r of rows) {
        if (doc.y > 760) {
          doc.addPage();
          header();
        }
        const time = (s: string | null) => (s ? s.slice(11, 16) : "—");
        const cells = [
          r.local_date, time(r.start_local), time(r.end_local), hm(r.break_minutes),
          r.status === "open" ? "—" : hm(r.effective_minutes), r.status === "open" ? "—" : hm(r.rounded_minutes),
          r.status + (r.adjusted ? " (adj.)" : ""), r.location ?? "",
        ];
        let x = 40;
        const y = doc.y;
        doc.fontSize(8);
        cells.forEach((cell, i) => {
          doc.text(cell, x, y, { width: cols[i]!.w, lineBreak: false, ellipsis: true });
          x += cols[i]!.w;
        });
        doc.moveDown(0.5);
      }
      const counted = rows.filter((r) => r.status !== "open");
      const exact = counted.reduce((s, r) => s + r.effective_seconds / 60, 0);
      const rounded = counted.reduce((s, r) => s + r.rounded_minutes, 0);
      doc.fontSize(9).font("Helvetica-Bold").text(`Total: ${hm(exact)} exact, ${hm(rounded)} rounded (${counted.length} sessions)`, 40);
      doc.font("Helvetica").moveDown(0.8);
    }
    if (ds.rows.length === 0) doc.fontSize(10).text("No sessions in this period.");
    doc.moveDown().fontSize(10).font("Helvetica-Bold");
    doc.text(`Grand total: ${hm(ds.totals.effective_seconds / 60)} exact, ${hm(ds.totals.rounded_minutes)} rounded — ${ds.totals.sessions} sessions`, 40);
    doc.end();
  });
}

/**
 * Creates an export from a consistent REPEATABLE READ snapshot, stores the protected file with a
 * checksum, and logs actor, filters, timezone, rounding and record version.
 */
export async function createExport(db: Db, ctx: AuditContext, user: AuthUser, input: ExportInput) {
  const scope = await requireProjectRole(db, user, input.project_id, "supervisor");
  const tz = input.timezone ?? scope.project.timezone;
  const range = localDateRange(input.from, input.to, tz);
  const filters = { from: input.from, to: input.to, tutor_ids: input.tutor_ids ?? null, group_by: input.group_by, range_start: range.start, range_end: range.end };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO export_jobs (project_id, requested_by, format, filters, timezone, rounding_policy, status)
     VALUES ($1,$2,$3,$4,$5,$6,'processing') RETURNING id`,
    [scope.project.id, user.id, input.format, JSON.stringify(filters), tz, JSON.stringify(scope.project.settings.rounding)],
  );
  const id = rows[0]!.id;
  try {
    await withTransaction(
      db,
      async (tx) => {
        const now = new Date();
        const ds = await buildDataset(tx, scope, { ...input, timezone: tz }, now);
        const content =
          input.format === "csv"
            ? Buffer.from(renderCsv(ds, input.group_by), "utf8")
            : await renderPdf(ds, { projectName: scope.project.name, from: input.from, to: input.to, exportId: id, generatedBy: user.display_name, generatedAt: now });
        const checksum = createHash("sha256").update(content).digest("hex");
        const fileName = `timesheet_${input.from}_${input.to}_${id.slice(0, 8)}.${input.format}`;
        await tx.query(
          `UPDATE export_jobs SET status = 'completed', record_version = $2, file_name = $3, content_type = $4,
                  file_content = $5, checksum = $6, row_count = $7, total_seconds = $8, completed_at = now(),
                  expires_at = now() + ($9 || ' days')::interval
            WHERE id = $1`,
          [id, ds.record_version, fileName, input.format === "csv" ? "text/csv; charset=utf-8" : "application/pdf", content, checksum, ds.rows.length, ds.totals.effective_seconds, EXPORT_TTL_DAYS],
        );
        await writeAudit(tx, ctx, {
          projectId: scope.project.id,
          action: "export.created",
          targetType: "export_job",
          targetId: id,
          after: { format: input.format, filters, timezone: tz, rounding: scope.project.settings.rounding, record_version: ds.record_version, checksum, rows: ds.rows.length },
        });
      },
      "REPEATABLE READ",
    );
  } catch (err) {
    await db.query(`UPDATE export_jobs SET status = 'failed', error = $2 WHERE id = $1`, [id, err instanceof ApiError ? err.message : "Export failed"]);
    throw err;
  }
  return getExport(db, user, id);
}

const EXPORT_COLUMNS = `e.id, e.project_id, e.format, e.filters, e.timezone, e.rounding_policy, e.record_version, e.status,
  e.file_name, e.checksum, e.row_count, e.total_seconds, e.error, e.created_at, e.completed_at, e.expires_at,
  u.display_name AS requested_by_name,
  (e.status = 'completed' AND (
     EXISTS (SELECT 1 FROM time_adjustments ta JOIN work_sessions s ON s.id = ta.session_id
              WHERE ta.project_id = e.project_id AND ta.created_at > e.completed_at
                AND s.started_at >= (e.filters->>'range_start')::timestamptz - interval '1 day'
                AND s.started_at < (e.filters->>'range_end')::timestamptz + interval '1 day')
  OR EXISTS (SELECT 1 FROM clock_events ce JOIN work_sessions s ON s.id = ce.session_id
              WHERE ce.project_id = e.project_id AND ce.received_at > e.completed_at
                AND s.started_at >= (e.filters->>'range_start')::timestamptz
                AND s.started_at < (e.filters->>'range_end')::timestamptz)
  )) AS potentially_superseded`;

export async function listExports(db: Db, user: AuthUser, projectId: string) {
  await requireProjectRole(db, user, projectId, "supervisor");
  const { rows } = await db.query(
    `SELECT ${EXPORT_COLUMNS} FROM export_jobs e JOIN users u ON u.id = e.requested_by
      WHERE e.project_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
    [projectId],
  );
  return rows;
}

export async function getExport(db: Db, user: AuthUser, id: string) {
  const { rows } = await db.query(
    `SELECT ${EXPORT_COLUMNS} FROM export_jobs e JOIN users u ON u.id = e.requested_by WHERE e.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound("Export not found.");
  await requireProjectRole(db, user, rows[0].project_id, "supervisor");
  return rows[0];
}

export async function downloadExport(db: Db, ctx: AuditContext, user: AuthUser, id: string) {
  const { rows } = await db.query<{ project_id: string; status: string; file_name: string; content_type: string; file_content: Buffer; expires_at: Date; checksum: string }>(
    `SELECT project_id, status, file_name, content_type, file_content, expires_at, checksum FROM export_jobs WHERE id = $1`,
    [id],
  );
  const job = rows[0];
  if (!job) throw notFound("Export not found.");
  await requireProjectRole(db, user, job.project_id, "supervisor");
  if (job.status !== "completed") throw badRequest("NOT_READY", "This export is not ready.");
  if (job.expires_at < new Date()) throw new ApiError(410, "EXPIRED", "This export file has expired. Generate a new export.");
  await writeAudit(db, ctx, { projectId: job.project_id, action: "export.downloaded", targetType: "export_job", targetId: id });
  return job;
}

export async function previewExport(db: Db, user: AuthUser, input: ExportInput) {
  const scope = await requireProjectRole(db, user, input.project_id, "supervisor");
  const ds = await buildDataset(db, scope, input, new Date());
  return {
    totals: ds.totals,
    rounding_rule: describeRounding(ds.rounding),
    timezone: ds.timezone,
    record_version: ds.record_version,
    tutors: groupTutorTotals(ds.rows),
  };
}

function groupTutorTotals(rows: ExportRow[]) {
  const m = new Map<string, { tutor_id: string; tutor_name: string; sessions: number; exact_minutes: number; rounded_minutes: number }>();
  for (const r of rows) {
    if (r.status === "open") continue;
    const t = m.get(r.tutor_id) ?? { tutor_id: r.tutor_id, tutor_name: r.tutor_name, sessions: 0, exact_minutes: 0, rounded_minutes: 0 };
    t.sessions += 1;
    t.exact_minutes = Math.round((t.exact_minutes + r.effective_seconds / 60) * 100) / 100;
    t.rounded_minutes = Math.round((t.rounded_minutes + r.rounded_minutes) * 100) / 100;
    m.set(r.tutor_id, t);
  }
  return [...m.values()];
}
