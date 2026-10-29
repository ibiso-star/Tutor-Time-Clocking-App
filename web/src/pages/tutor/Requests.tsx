import { Link } from "react-router-dom";
import { get, post, qs } from "../../api";
import { useSession } from "../../session";
import { dateTime, ISSUE_LABELS } from "../../format";
import { ErrorNotice, Loading, ReviewStatus, useAnnounce, useLoad, useTitle } from "../../components/ui";

interface Req {
  id: string;
  session_id: string;
  requested_change: { issue: string; clock_in_at?: string; clock_out_at?: string };
  explanation: string;
  status: string;
  submitted_at: string;
  decision_reason: string | null;
  resolved_by_name: string | null;
  session_started_at: string;
}

export default function Requests() {
  useTitle("Correction requests");
  const { projectId, tz } = useSession();
  const announce = useAnnounce();
  const { data, error, loading, reload } = useLoad(() => get<{ corrections: Req[] }>(`/v1/me/correction-requests${qs({ project_id: projectId })}`), [projectId]);
  const withdraw = async (id: string) => {
    await post(`/v1/me/correction-requests/${id}/withdraw`);
    announce("Request withdrawn.");
    void reload();
  };
  return (
    <div>
      <h1>Correction requests</h1>
      <p className="muted">To ask for a change, open the session in your history and choose Request a correction.</p>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.corrections.length === 0 ? (
        <p className="empty">You haven't requested any corrections.</p>
      ) : (
        <ul className="list">
          {data?.corrections.map((c) => (
            <li key={c.id} style={{ padding: "0.9rem 1rem" }}>
              <div className="section-head" style={{ marginBottom: "0.25rem" }}>
                <Link to={`/history/${c.session_id}`} style={{ fontWeight: 700 }}>
                  Session of {dateTime(c.session_started_at, tz)}
                </Link>
                <ReviewStatus status={c.status} />
              </div>
              <div className="small">
                {ISSUE_LABELS[c.requested_change.issue]}
                {c.requested_change.clock_in_at ? `; start ${dateTime(c.requested_change.clock_in_at, tz)}` : ""}
                {c.requested_change.clock_out_at ? `; end ${dateTime(c.requested_change.clock_out_at, tz)}` : ""}
              </div>
              <div className="small muted">Submitted {dateTime(c.submitted_at, tz)}. Reference {c.id.slice(0, 8)}.</div>
              {c.decision_reason && (
                <p className="small" style={{ margin: "0.4rem 0 0" }}>
                  {c.resolved_by_name ?? "Reviewer"}: {c.decision_reason}
                </p>
              )}
              {c.status === "pending" && (
                <button className="btn btn-quiet" style={{ paddingLeft: 0 }} onClick={() => void withdraw(c.id)}>
                  Withdraw request
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
