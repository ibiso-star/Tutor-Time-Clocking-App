import type { ReactNode } from "react";
import { dateTime, ISSUE_LABELS, timeWithSeconds } from "../format";
import { ReviewStatus } from "./ui";

export interface EventItem {
  id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  client_captured_at: string | null;
  source: string;
  sync_status: string;
  actor: { name: string };
  metadata: Record<string, any>;
}
export interface AdjustmentItem {
  id: string;
  adjustment_type: string;
  effective_start: string | null;
  effective_end: string | null;
  delta_minutes: number | null;
  reason: string;
  superseded: boolean;
  source_correction_id: string | null;
  created_by: { name: string };
  created_at: string;
}
export interface CorrectionItem {
  id: string;
  status: string;
  requested_change: { issue: string; clock_in_at?: string | null; clock_out_at?: string | null };
  explanation: string;
  submitted_at: string;
  resolved_at: string | null;
  decision_reason: string | null;
  resolved_by_name?: string | null;
}

const EVENT_TEXT: Record<string, string> = { clock_in: "Clocked in", clock_out: "Clocked out", break_start: "Break started", break_end: "Break ended" };
const SOURCE_TEXT: Record<string, string> = { web: "recorded by the server", admin_adjustment: "recorded during review", system: "imported", offline_sync: "synced from device" };
const ADJ_TEXT: Record<string, string> = { add_time: "Time added", replace_interpretation: "Times corrected", void_session: "Session voided", other: "Note added" };

/** Original events, corrections and adjustments in one chronological record. Nothing is ever removed. */
export function Timeline({ events, adjustments, corrections, tz, showMeta = false }: { events: EventItem[]; adjustments: AdjustmentItem[]; corrections: CorrectionItem[]; tz: string; showMeta?: boolean }) {
  type Row = { at: string; kind: string; node: ReactNode };
  const rows: Row[] = [
    ...events.map((e) => ({
      at: e.occurred_at,
      kind: e.event_type,
      node: (
        <>
          <strong>{EVENT_TEXT[e.event_type] ?? e.event_type}</strong> <span className="num">{timeWithSeconds(e.occurred_at, tz)}</span>
          <div className="small muted">
            {SOURCE_TEXT[e.source] ?? e.source}
            {e.source !== "web" ? ` by ${e.actor.name}` : ""}
            {e.metadata?.reason ? `: ${e.metadata.reason}` : ""}
            {e.metadata?.geofence === "outside" ? ", outside the approved area" : e.metadata?.geofence === "unverified" ? ", location not verified" : ""}
          </div>
          {showMeta && e.client_captured_at && <div className="small muted">Device time (not official): {timeWithSeconds(e.client_captured_at, tz)}</div>}
        </>
      ),
    })),
    ...corrections.map((c) => ({
      at: c.submitted_at,
      kind: "correction",
      node: (
        <>
          <strong>Correction requested</strong> <ReviewStatus status={c.status} />
          <div className="small">
            {ISSUE_LABELS[c.requested_change.issue] ?? c.requested_change.issue}
            {c.requested_change.clock_in_at ? `; start ${dateTime(c.requested_change.clock_in_at, tz)}` : ""}
            {c.requested_change.clock_out_at ? `; end ${dateTime(c.requested_change.clock_out_at, tz)}` : ""}
          </div>
          <div className="small muted">"{c.explanation}"</div>
          {c.decision_reason && (
            <div className="small">
              Decision{c.resolved_by_name ? ` by ${c.resolved_by_name}` : ""}: {c.decision_reason}
            </div>
          )}
        </>
      ),
    })),
    ...adjustments.map((a) => ({
      at: a.created_at,
      kind: "adjustment",
      node: (
        <>
          <strong>{ADJ_TEXT[a.adjustment_type] ?? a.adjustment_type}</strong>
          {a.superseded && <span className="status status-out" style={{ marginLeft: 6 }}>Replaced</span>}
          <div className="small">
            {a.adjustment_type === "replace_interpretation" && `${a.effective_start ? `Start ${dateTime(a.effective_start, tz)}` : ""}${a.effective_end ? `${a.effective_start ? ", e" : "E"}nd ${dateTime(a.effective_end, tz)}` : ""}`}
            {a.adjustment_type === "add_time" && `${a.delta_minutes! > 0 ? "+" : ""}${a.delta_minutes} min`}
          </div>
          <div className="small muted">
            By {a.created_by.name}
            {a.source_correction_id ? " (approved correction)" : ""}: {a.reason}
          </div>
        </>
      ),
    })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  return (
    <ol className="timeline">
      {rows.map((r, i) => (
        <li key={i} data-kind={r.kind}>
          {r.node}
        </li>
      ))}
    </ol>
  );
}
