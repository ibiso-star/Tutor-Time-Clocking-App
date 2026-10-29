import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, get, post } from "../../api";
import { useSession } from "../../session";
import { dateTime, hm, isoToLocalInput, localInputToIso, tzShort } from "../../format";
import { Timeline, type AdjustmentItem, type CorrectionItem, type EventItem } from "../../components/Timeline";
import { Dialog, ErrorNotice, Field, Flags, Loading, StateBadge, useAnnounce, useLoad, useTitle, type Flag } from "../../components/ui";

interface Detail {
  id: string;
  tutor: { id: string; name: string; email: string };
  state: "in" | "break" | "closed";
  local_date: string;
  timezone: string;
  rounding: { mode: string; increment_minutes: number };
  raw: { start: string; end: string | null; work_seconds: number; break_seconds: number };
  effective: { start: string; end: string | null; work_seconds: number; voided: boolean; delta_minutes: number; adjusted: boolean };
  rounded_minutes: number;
  location: { name: string | null } | null;
  shift: { label: string | null } | null;
  flags: Flag[];
  events: EventItem[];
  adjustments: AdjustmentItem[];
  corrections: CorrectionItem[];
  audit: { id: string; action: string; actor_name: string | null; occurred_at: string; reason: string | null; request_id: string | null }[];
}

export default function AdminSession() {
  useTitle("Session record");
  const { id } = useParams();
  const { tz } = useSession();
  const { data, error, loading, reload } = useLoad(() => get<Detail>(`/v1/admin/sessions/${id}`), [id]);
  const [adjusting, setAdjusting] = useState<null | "general" | "close">(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const st = data.state === "closed" ? "OUT" : data.state === "break" ? "BREAK" : "IN";
  const changed = data.raw.start !== data.effective.start || data.raw.end !== data.effective.end || data.raw.work_seconds !== data.effective.work_seconds;
  return (
    <div>
      <p><Link to="/admin/entries">Time entries</Link></p>
      <div className="page-head">
        <div>
          <h1>{data.tutor.name}</h1>
          <p className="muted">
            Session started {dateTime(data.raw.start, tz)}
            {data.location?.name ? ` at ${data.location.name}` : ""}
            {data.shift?.label ? `, shift "${data.shift.label}"` : ""}
          </p>
        </div>
        <div className="btn-row">
          {data.state !== "closed" && (
            <button className="btn btn-primary" onClick={() => setAdjusting("close")}>Record clock-out time</button>
          )}
          <button className="btn" onClick={() => setAdjusting("general")}>Adjust time</button>
        </div>
      </div>
      <p><StateBadge state={st} /> <Flags flags={data.flags} /></p>

      <div className="two-col">
        <div className="stack">
          <section className="panel" aria-labelledby="calc">
            <h2 id="calc">Calculation</h2>
            <div className="compare">
              <dl>
                <dt>Original clock record</dt>
                <dd>{dateTime(data.raw.start, tz)}</dd>
                <dd>{data.raw.end ? dateTime(data.raw.end, tz) : "Open"}</dd>
                <dt>Worked</dt>
                <dd>{hm(data.raw.work_seconds)}</dd>
                <dt>Breaks</dt>
                <dd>{hm(data.raw.break_seconds)}</dd>
              </dl>
              <dl>
                <dt>{changed ? "After adjustments" : "Effective (no adjustments)"}</dt>
                <dd>{dateTime(data.effective.start, tz)}</dd>
                <dd>{data.effective.end ? dateTime(data.effective.end, tz) : "Open"}</dd>
                <dt>Worked</dt>
                <dd>{data.effective.voided ? "Voided (0h 00m)" : hm(data.effective.work_seconds)}</dd>
                <dt>For payroll ({data.rounding.mode === "none" ? "exact" : `rounded ${data.rounding.mode} ${data.rounding.increment_minutes} min`})</dt>
                <dd>{data.state === "closed" ? `${data.rounded_minutes} min` : "Not final while the session is open"}</dd>
              </dl>
            </div>
          </section>
          <section className="panel" aria-labelledby="tl">
            <h2 id="tl">Record</h2>
            <p className="small muted">Original events are never edited. Corrections and adjustments are added alongside them.</p>
            <Timeline events={data.events} adjustments={data.adjustments} corrections={data.corrections} tz={tz} showMeta />
          </section>
        </div>
        <section className="panel" aria-labelledby="audit">
          <h2 id="audit">Audit trail</h2>
          {data.audit.length === 0 && <p className="muted small">No audit entries for this session. Demo data loaded directly is not audited.</p>}
          <ol className="list" style={{ border: 0 }}>
            {data.audit.map((a) => (
              <li key={a.id} style={{ padding: "0.5rem 0" }}>
                <div><strong>{a.action}</strong></div>
                <div className="small muted">
                  {dateTime(a.occurred_at, tz)} by {a.actor_name ?? "system"}
                  {a.reason ? `: ${a.reason}` : ""}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <Dialog open={adjusting !== null} onClose={() => setAdjusting(null)} title={adjusting === "close" ? "Record clock-out time" : "Adjust time"}>
        {adjusting && (
          <AdjustmentEditor
            detail={data}
            tz={tz}
            mode={adjusting}
            onDone={() => { setAdjusting(null); void reload(); }}
            onCancel={() => setAdjusting(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

interface Preview {
  before: { start: string; end: string | null; work_seconds: number; rounded_minutes: number; voided: boolean };
  after: { start: string; end: string | null; work_seconds: number; rounded_minutes: number; voided: boolean };
  closes_open_session: boolean;
  affected_exports: { id: string; format: string; from: string; to: string }[];
}

function AdjustmentEditor({ detail, tz, mode, onDone, onCancel }: { detail: Detail; tz: string; mode: "general" | "close"; onDone: () => void; onCancel: () => void }) {
  const announce = useAnnounce();
  const [type, setType] = useState(mode === "close" ? "replace_interpretation" : "replace_interpretation");
  const [start, setStart] = useState(isoToLocalInput(detail.effective.start, tz));
  const [end, setEnd] = useState(detail.effective.end ? isoToLocalInput(detail.effective.end, tz) : "");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const activeAdjustments = detail.adjustments.filter((a) => !a.superseded);
  const [supersedes, setSupersedes] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const body = () => ({
    session_id: detail.id,
    adjustment_type: type,
    effective_start: type === "replace_interpretation" && mode === "general" && start ? localInputToIso(start, tz) : null,
    effective_end: type === "replace_interpretation" && end ? localInputToIso(end, tz) : null,
    delta_minutes: type === "add_time" ? Number(delta) : null,
    reason,
    supersedes_adjustment_id: supersedes || null,
  });
  const runPreview = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await post<Preview>("/v1/admin/adjustments/preview", body()));
    } catch (err) {
      setError(err as ApiError);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await post("/v1/admin/adjustments", body());
      announce(mode === "close" ? "Clock-out recorded. The session is closed." : "Adjustment saved.");
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const invalidate = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPreview(null); };

  return (
    <form onSubmit={runPreview} noValidate>
      <p className="small muted">Times are in {tzShort(tz)}. The original clock events stay in the record; this adds an attributed adjustment.</p>
      {mode === "general" && (
        <Field label="Type of adjustment">
          {(p) => (
            <select {...p} value={type} onChange={(e) => invalidate(setType)(e.target.value)}>
              <option value="replace_interpretation">Correct start or end time</option>
              <option value="add_time">Add or remove minutes</option>
              <option value="void_session">Void this session</option>
              <option value="other">Add a note (no time change)</option>
            </select>
          )}
        </Field>
      )}
      {type === "replace_interpretation" && mode === "general" && (
        <Field label="Start" error={error?.field("effective_start")}>
          {(p) => <input {...p} type="datetime-local" value={start} onChange={(e) => invalidate(setStart)(e.target.value)} />}
        </Field>
      )}
      {type === "replace_interpretation" && (
        <Field label={mode === "close" ? "When did the tutor actually stop working?" : "End"} hint={detail.state !== "closed" ? "Setting an end time closes this open session so the tutor can clock in again." : undefined}>
          {(p) => <input {...p} type="datetime-local" value={end} onChange={(e) => invalidate(setEnd)(e.target.value)} required={mode === "close"} />}
        </Field>
      )}
      {type === "add_time" && (
        <Field label="Minutes" hint="Use a negative number to remove time." error={error?.field("delta_minutes")}>
          {(p) => <input {...p} type="number" inputMode="numeric" value={delta} onChange={(e) => invalidate(setDelta)(e.target.value)} />}
        </Field>
      )}
      {activeAdjustments.length > 0 && mode === "general" && (
        <Field label="Replaces an earlier adjustment?" hint="Choose one to supersede it; otherwise this is added on top.">
          {(p) => (
            <select {...p} value={supersedes} onChange={(e) => invalidate(setSupersedes)(e.target.value)}>
              <option value="">No, add on top</option>
              {activeAdjustments.map((a) => (
                <option key={a.id} value={a.id}>{a.adjustment_type.replaceAll("_", " ")} by {a.created_by.name}: {a.reason.slice(0, 40)}</option>
              ))}
            </select>
          )}
        </Field>
      )}
      <Field label="Reason" hint="Required. Visible to reviewers and in the audit log." error={error?.field("reason")}>
        {(p) => <textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} required />}
      </Field>
      {error && !error.details?.fields && <ErrorNotice error={error} />}
      {preview && (
        <div className="stack" style={{ marginBottom: "1rem" }}>
          <div className="compare">
            <dl>
              <dt>Before</dt>
              <dd>{dateTime(preview.before.start, tz)} to {preview.before.end ? dateTime(preview.before.end, tz) : "open"}</dd>
              <dd>{hm(preview.before.work_seconds)}</dd>
            </dl>
            <dl>
              <dt>After</dt>
              <dd>{dateTime(preview.after.start, tz)} to {preview.after.end ? dateTime(preview.after.end, tz) : "open"}</dd>
              <dd>{preview.after.voided ? "Voided" : hm(preview.after.work_seconds)}</dd>
            </dl>
          </div>
          {preview.closes_open_session && <p className="notice small">This will close the open session.</p>}
          {preview.affected_exports.length > 0 && (
            <div className="notice notice-warn">
              <p>
                This session is included in {preview.affected_exports.length} earlier export{preview.affected_exports.length > 1 ? "s" : ""} (
                {preview.affected_exports.map((e) => `${e.from} to ${e.to}`).join("; ")}). They'll be marked as possibly out of date; generate a new export afterwards.
              </p>
            </div>
          )}
        </div>
      )}
      <div className="btn-row">
        {preview ? (
          <button className="btn btn-primary" type="button" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Saving…" : mode === "close" ? "Record clock-out" : "Save adjustment"}
          </button>
        ) : (
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Checking…" : "Preview change"}
          </button>
        )}
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
