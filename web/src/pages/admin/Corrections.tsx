import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, get, post, qs } from "../../api";
import { useSession } from "../../session";
import { dateTime, ISSUE_LABELS } from "../../format";
import { Dialog, ErrorNotice, Field, Loading, ReviewStatus, useAnnounce, useLoad, useTitle } from "../../components/ui";

interface Req {
  id: string;
  session_id: string;
  requester_name: string;
  requested_change: { issue: string; clock_in_at?: string | null; clock_out_at?: string | null };
  explanation: string;
  status: string;
  submitted_at: string;
  decision_reason: string | null;
  resolved_by_name: string | null;
  version: number;
  session_started_at: string;
  session_closed_at: string | null;
  session_state: string;
  age_seconds: number;
}

export default function Corrections() {
  useTitle("Corrections");
  const { projectId, tz } = useSession();
  const [status, setStatus] = useState("pending");
  const { data, error, loading, reload } = useLoad(
    () => get<{ corrections: Req[]; service_target_hours: number }>(`/v1/admin/correction-requests${qs({ project_id: projectId, status })}`),
    [projectId, status],
  );
  const [open, setOpen] = useState<Req | null>(null);
  const age = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Correction requests</h1>
          {data && <p className="muted small">Target: resolve within {data.service_target_hours} hours.</p>}
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="cs">Show</label>
          <select id="cs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.corrections.length === 0 ? (
        <p className="empty">{status === "pending" ? "Nothing waiting for review." : "No requests."}</p>
      ) : (
        <div className="table-wrap">
          <table className="data stack-sm">
            <thead>
              <tr>
                <th scope="col">Tutor</th>
                <th scope="col">Session</th>
                <th scope="col">Request</th>
                <th scope="col">Waiting</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {data?.corrections.map((c) => {
                const overdue = c.status === "pending" && c.age_seconds > (data.service_target_hours ?? 72) * 3600;
                return (
                  <tr key={c.id}>
                    <td data-label="Tutor">{c.requester_name}</td>
                    <td data-label="Session"><Link to={`/admin/sessions/${c.session_id}`}>{dateTime(c.session_started_at, tz)}</Link></td>
                    <td data-label="Request">{ISSUE_LABELS[c.requested_change.issue]}</td>
                    <td data-label="Waiting" className="num">
                      {age(c.age_seconds)}
                      {overdue && <span className="status status-bad" style={{ marginLeft: 6 }}>Over target</span>}
                    </td>
                    <td data-label="Status"><ReviewStatus status={c.status} /></td>
                    <td data-label="">
                      <button className="btn" onClick={() => setOpen(c)}>{c.status === "pending" ? "Review" : "View"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? `Correction from ${open.requester_name}` : ""}>
        {open && <Decision req={open} tz={tz} onDone={() => { setOpen(null); void reload(); }} onCancel={() => setOpen(null)} />}
      </Dialog>
    </div>
  );
}

function Decision({ req, tz, onDone, onCancel }: { req: Req; tz: string; onDone: () => void; onCancel: () => void }) {
  const announce = useAnnounce();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      await post(`/v1/admin/correction-requests/${req.id}/decision`, { decision, reason, version: req.version });
      announce(decision === "approve" ? "Correction approved. An adjustment was added." : "Correction rejected. The record is unchanged.");
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const rc = req.requested_change;
  return (
    <div>
      <p className="muted small">Submitted {dateTime(req.submitted_at, tz)}. {ISSUE_LABELS[rc.issue]}.</p>
      <div className="compare" style={{ marginBottom: "1rem" }}>
        <dl>
          <dt>Recorded</dt>
          <dd>Start {dateTime(req.session_started_at, tz)}</dd>
          <dd>End {req.session_closed_at ? dateTime(req.session_closed_at, tz) : "still open"}</dd>
        </dl>
        <dl>
          <dt>Requested</dt>
          <dd>Start {rc.clock_in_at ? dateTime(rc.clock_in_at, tz) : "unchanged"}</dd>
          <dd>End {rc.clock_out_at ? dateTime(rc.clock_out_at, tz) : "unchanged"}</dd>
        </dl>
      </div>
      <blockquote className="panel" style={{ margin: "0 0 1rem" }}>"{req.explanation}"</blockquote>
      <p className="small"><Link to={`/admin/sessions/${req.session_id}`}>Open the full session record</Link></p>
      {req.status === "pending" ? (
        <>
          <Field label="Reason for your decision" hint="Shared with the tutor and kept in the audit log." error={error?.field("reason")}>
            {(p) => <textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />}
          </Field>
          {error && !error.details?.fields && <ErrorNotice error={error} />}
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!!busy || reason.trim().length < 3} onClick={() => void decide("approve")}>
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button className="btn btn-danger" disabled={!!busy || reason.trim().length < 3} onClick={() => void decide("reject")}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button className="btn" onClick={onCancel}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p><ReviewStatus status={req.status} /> {req.resolved_by_name && `by ${req.resolved_by_name}`}</p>
          {req.decision_reason && <p>{req.decision_reason}</p>}
          <button className="btn" onClick={onCancel}>Close</button>
        </>
      )}
    </div>
  );
}
