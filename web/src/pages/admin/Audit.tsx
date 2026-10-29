import { useState } from "react";
import { get, qs } from "../../api";
import { useSession } from "../../session";
import { dateTime } from "../../format";
import { ErrorNotice, Loading, useLoad, useTitle } from "../../components/ui";

interface Entry { id: string; action: string; target_type: string; target_id: string | null; reason: string | null; before: unknown; after: unknown; occurred_at: string; request_id: string | null; actor_name: string | null; user_agent_summary: string | null }

const PREFIXES = [["", "All actions"], ["clock.", "Clock events"], ["correction.", "Corrections"], ["adjustment.", "Adjustments"], ["export.", "Exports"], ["project.", "Settings"], ["membership.", "People"], ["auth.", "Sign-in"]];

export default function Audit() {
  useTitle("Audit log");
  const { projectId, tz } = useSession();
  const [action, setAction] = useState("");
  const { data, error, loading, reload } = useLoad(() => get<{ entries: Entry[] }>(`/v1/admin/audit-logs${qs({ project_id: projectId, action, limit: 200 })}`), [projectId, action]);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted small">Append-only. Entries cannot be edited or deleted.</p>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="act">Show</label>
          <select id="act" value={action} onChange={(e) => setAction(e.target.value)}>
            {PREFIXES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap">
          <table className="data stack-sm">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Reason</th><th scope="col">Details</th></tr></thead>
            <tbody>
              {data?.entries.length === 0 && <tr><td colSpan={5} className="empty">No entries.</td></tr>}
              {data?.entries.map((e) => (
                <tr key={e.id}>
                  <td data-label="When" className="num">{dateTime(e.occurred_at, tz)}</td>
                  <td data-label="Who">{e.actor_name ?? "System"}{e.user_agent_summary && <div className="small muted">{e.user_agent_summary}</div>}</td>
                  <td data-label="Action">{e.action}<div className="small muted">{e.target_type}</div></td>
                  <td data-label="Reason">{e.reason ?? "—"}</td>
                  <td data-label="Details">
                    {(e.before != null || e.after != null) && (
                      <details>
                        <summary>Show change</summary>
                        <pre className="small" style={{ whiteSpace: "pre-wrap", maxWidth: "40rem", overflowX: "auto" }}>{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                      </details>
                    )}
                    {e.request_id && <div className="small muted">Request {e.request_id.slice(0, 8)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
