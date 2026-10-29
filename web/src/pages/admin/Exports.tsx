import { useState, type FormEvent } from "react";
import { ApiError, get, post, qs } from "../../api";
import { useSession } from "../../session";
import { dateTime, hm, todayIn } from "../../format";
import { ErrorNotice, Field, Loading, useAnnounce, useLoad, useTitle } from "../../components/ui";

const ZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "UTC"];

interface Preview {
  totals: { sessions: number; open_sessions_excluded: number; effective_seconds: number; rounded_minutes: number };
  rounding_rule: string;
  timezone: string;
  record_version: string;
  tutors: { tutor_id: string; tutor_name: string; sessions: number; exact_minutes: number; rounded_minutes: number }[];
}

export default function Exports() {
  useTitle("Exports");
  const { projectId, tz } = useSession();
  const announce = useAnnounce();
  const [format, setFormat] = useState<"csv" | "pdf">("csv");
  const [from, setFrom] = useState(todayIn(tz, -13));
  const [to, setTo] = useState(todayIn(tz, -1));
  const [zone, setZone] = useState(tz);
  const [groupBy, setGroupBy] = useState<"session" | "tutor_day">("session");
  const [tutorIds, setTutorIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const people = useLoad(() => get(`/v1/admin/people${qs({ project_id: projectId })}`), [projectId]);
  const history = useLoad(() => get<{ exports: any[] }>(`/v1/admin/exports${qs({ project_id: projectId })}`), [projectId]);
  const body = () => ({ project_id: projectId, format, from, to, timezone: zone, group_by: groupBy, tutor_ids: tutorIds.length ? tutorIds : null });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPreview(null); };

  const doPreview = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await post<Preview>("/v1/admin/exports/preview", body()));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await post("/v1/admin/exports", body());
      announce(`Export ready: ${job.file_name}.`);
      window.location.href = `/v1/admin/exports/${job.id}/download`;
      void history.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const zones = ZONES.includes(tz) ? ZONES : [tz, ...ZONES];
  const tutors = (people.data?.people ?? []).filter((p: any) => p.role === "tutor");

  return (
    <div>
      <div className="page-head">
        <h1>Exports</h1>
      </div>
      <div className="two-col">
        <form className="panel" onSubmit={doPreview} noValidate>
          <h2>New timesheet export</h2>
          <fieldset>
            <legend>Format</legend>
            <label className="check"><input type="radio" name="fmt" checked={format === "csv"} onChange={() => reset(setFormat)("csv")} /> CSV for payroll import</label>
            <label className="check"><input type="radio" name="fmt" checked={format === "pdf"} onChange={() => reset(setFormat)("pdf")} /> PDF for records and sign-off</label>
          </fieldset>
          <div className="filters">
            <Field label="From">{(p) => <input {...p} type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />}</Field>
            <Field label="To" error={error?.field("to")}>{(p) => <input {...p} type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} />}</Field>
          </div>
          <Field label="Timezone" hint="Dates and times in the file use this zone. Sessions count on the date they started.">
            {(p) => (
              <select {...p} value={zone} onChange={(e) => reset(setZone)(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z}{z === tz ? " (project)" : ""}</option>)}
              </select>
            )}
          </Field>
          {format === "csv" && (
            <Field label="One row per">
              {(p) => (
                <select {...p} value={groupBy} onChange={(e) => reset(setGroupBy)(e.target.value as typeof groupBy)}>
                  <option value="session">Session</option>
                  <option value="tutor_day">Tutor per day</option>
                </select>
              )}
            </Field>
          )}
          <fieldset>
            <legend>Tutors</legend>
            <label className="check"><input type="checkbox" checked={tutorIds.length === 0} onChange={() => reset(setTutorIds)([])} /> Everyone in my scope</label>
            {tutors.map((t: any) => (
              <label key={t.user_id} className="check">
                <input
                  type="checkbox"
                  checked={tutorIds.includes(t.user_id)}
                  onChange={(e) => reset(setTutorIds)(e.target.checked ? [...tutorIds, t.user_id] : tutorIds.filter((x) => x !== t.user_id))}
                />
                {t.display_name}
              </label>
            ))}
          </fieldset>
          {error && !error.details?.fields && <ErrorNotice error={error} />}
          {!preview ? (
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Calculating…" : "Preview totals"}</button>
          ) : (
            <div className="stack">
              <div className="notice">
                <p>
                  <strong className="num">{hm(preview.totals.effective_seconds)}</strong> across {preview.totals.sessions} sessions. Rounding: {preview.rounding_rule}.
                  {preview.totals.open_sessions_excluded > 0 && ` ${preview.totals.open_sessions_excluded} open session(s) will be listed but not counted.`}
                </p>
              </div>
              <table className="data">
                <thead><tr><th scope="col">Tutor</th><th scope="col" className="num">Sessions</th><th scope="col" className="num">Exact</th><th scope="col" className="num">Rounded</th></tr></thead>
                <tbody>
                  {preview.tutors.map((t) => (
                    <tr key={t.tutor_id}><td>{t.tutor_name}</td><td className="num">{t.sessions}</td><td className="num">{hm(t.exact_minutes * 60)}</td><td className="num">{hm(t.rounded_minutes * 60)}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="btn-row">
                <button className="btn btn-primary" type="button" onClick={() => void generate()} disabled={busy}>{busy ? "Generating…" : `Generate ${format.toUpperCase()}`}</button>
                <button className="btn" type="button" onClick={() => setPreview(null)}>Change filters</button>
              </div>
            </div>
          )}
        </form>

        <section className="panel" aria-labelledby="hist">
          <h2 id="hist">Export history</h2>
          {history.loading && !history.data ? <Loading /> : history.data?.exports.length === 0 ? (
            <p className="empty">No exports yet.</p>
          ) : (
            <ul className="list" style={{ border: 0 }}>
              {history.data?.exports.map((x) => {
                const expired = x.expires_at && new Date(x.expires_at) < new Date();
                return (
                  <li key={x.id} style={{ padding: "0.6rem 0" }}>
                    <div className="section-head" style={{ marginBottom: 0 }}>
                      <strong>{x.filters.from} to {x.filters.to}, {x.format.toUpperCase()}</strong>
                      {x.status === "completed" && !expired ? <a href={`/v1/admin/exports/${x.id}/download`}>Download</a> : <span className="muted small">{expired ? "Expired" : x.status}</span>}
                    </div>
                    <div className="small muted">
                      {dateTime(x.created_at, tz)} by {x.requested_by_name}. {x.row_count ?? 0} rows, {hm(Number(x.total_seconds ?? 0))}. Version {x.record_version}.
                    </div>
                    {x.potentially_superseded && <span className="status status-warn">Records changed since this export</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
