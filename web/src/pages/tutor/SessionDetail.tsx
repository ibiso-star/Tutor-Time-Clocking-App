import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, get, post } from "../../api";
import { useSession } from "../../session";
import { dateTime, hm, isoToLocalInput, ISSUE_LABELS, localInputToIso, tzShort } from "../../format";
import { Timeline, type AdjustmentItem, type CorrectionItem, type EventItem } from "../../components/Timeline";
import { Dialog, ErrorNotice, Field, Flags, Loading, useAnnounce, useLoad, useTitle, type Flag } from "../../components/ui";

interface Detail {
  id: string;
  state: string;
  timezone: string;
  raw: { start: string; end: string | null; work_seconds: number; break_seconds: number };
  effective: { start: string; end: string | null; work_seconds: number; adjusted: boolean; voided: boolean };
  location: { name: string | null } | null;
  flags: Flag[];
  events: EventItem[];
  adjustments: AdjustmentItem[];
  corrections: CorrectionItem[];
}

export default function SessionDetail() {
  useTitle("Session");
  const { id } = useParams();
  const { tz } = useSession();
  const { data, error, loading, reload } = useLoad(() => get<Detail>(`/v1/me/time-entries/${id}`), [id]);
  const [open, setOpen] = useState(false);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const pending = data.corrections.some((c) => c.status === "pending");
  return (
    <div>
      <p>
        <Link to="/history">Back to history</Link>
      </p>
      <h1>Session on {new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(data.effective.start))}</h1>
      <Flags flags={data.flags} />
      <div className="compare" style={{ marginTop: "1rem" }}>
        <dl>
          <dt>Start</dt>
          <dd>{dateTime(data.effective.start, tz)}</dd>
          <dt>End</dt>
          <dd>{data.effective.end ? dateTime(data.effective.end, tz) : "Still clocked in"}</dd>
        </dl>
        <dl>
          <dt>Breaks</dt>
          <dd>{hm(data.raw.break_seconds)}</dd>
          <dt>Worked</dt>
          <dd>{hm(data.effective.work_seconds)}</dd>
        </dl>
      </div>
      {data.effective.adjusted && (
        <p className="small muted" style={{ marginTop: "0.5rem" }}>
          Adjusted after review. Your original clock record was {hm(data.raw.work_seconds)} and is kept below.
        </p>
      )}

      <div className="section">
        {pending ? (
          <div className="notice">
            <p>Your correction request is pending review. Your original time record has not changed.</p>
          </div>
        ) : (
          <button className="btn" onClick={() => setOpen(true)}>
            Request a correction
          </button>
        )}
      </div>

      <section className="section" aria-labelledby="tl">
        <h2 id="tl">Record</h2>
        <Timeline events={data.events} adjustments={data.adjustments} corrections={data.corrections} tz={tz} />
      </section>

      <Dialog open={open} onClose={() => setOpen(false)} title="Request a correction">
        <CorrectionForm detail={data} tz={tz} onDone={() => { setOpen(false); void reload(); }} onCancel={() => setOpen(false)} />
      </Dialog>
    </div>
  );
}

function CorrectionForm({ detail, tz, onDone, onCancel }: { detail: Detail; tz: string; onDone: () => void; onCancel: () => void }) {
  const announce = useAnnounce();
  const [issue, setIssue] = useState(detail.effective.end ? "wrong_clock_out" : "missed_clock_out");
  const [inAt, setInAt] = useState(isoToLocalInput(detail.effective.start, tz));
  const [outAt, setOutAt] = useState(detail.effective.end ? isoToLocalInput(detail.effective.end, tz) : "");
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const wantsIn = issue === "wrong_clock_in";
  const wantsOut = issue === "wrong_clock_out" || issue === "missed_clock_out";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ id: string }>("/v1/correction-requests", {
        session_id: detail.id,
        requested_change: {
          issue,
          clock_in_at: wantsIn && inAt ? localInputToIso(inAt, tz) : null,
          clock_out_at: wantsOut && outAt ? localInputToIso(outAt, tz) : null,
        },
        explanation,
      });
      announce(`Correction submitted. Request ${res.id.slice(0, 8)} is pending review.`);
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate>
      <p className="small muted">Times are in {tzShort(tz)}. Your original record stays as it is; a supervisor reviews your request.</p>
      <Field label="What needs correcting?">
        {(p) => (
          <select {...p} value={issue} onChange={(e) => setIssue(e.target.value)}>
            {Object.entries(ISSUE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        )}
      </Field>
      {wantsIn && (
        <Field label="Correct clock-in time" error={error?.field("requested_change.clock_in_at")}>
          {(p) => <input {...p} type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} required />}
        </Field>
      )}
      {wantsOut && (
        <Field label="Correct clock-out time" error={error?.field("requested_change.clock_out_at")}>
          {(p) => <input {...p} type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} required />}
        </Field>
      )}
      <Field label="What happened?" hint="A short explanation helps your supervisor review quickly." error={error?.field("explanation")}>
        {(p) => <textarea {...p} value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={2000} required />}
      </Field>
      {error && !error.details?.fields && <ErrorNotice error={error} />}
      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Submitting…" : "Submit request"}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
