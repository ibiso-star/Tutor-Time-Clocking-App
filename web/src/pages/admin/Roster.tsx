import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post, qs } from "../../api";
import { useSession } from "../../session";
import { ago, hm, time } from "../../format";
import { ErrorNotice, Flags, Loading, StateBadge, useLoad, useTitle, type ClockState, type Flag } from "../../components/ui";

interface Row {
  tutor: { id: string; name: string; email: string; team: string | null };
  state: ClockState;
  active_session: { id: string; effective: { start: string; work_seconds: number }; location: { name: string | null } | null } | null;
  today_seconds: number;
  alerts: Flag[];
  pending_corrections: number;
}
interface Roster {
  totals: { tutors: number; clocked_in: number; on_break: number; clocked_out: number; with_alerts: number; pending_corrections: number };
  tutors: Row[];
  server_time: string;
}
interface Alert {
  id: string;
  event_type: string;
  title: string;
  body: string;
  related_entity_id: string | null;
  scheduled_at: string;
}

const ORDER: Record<ClockState, number> = { IN: 0, BREAK: 1, OUT: 2 };

export default function RosterPage() {
  useTitle("Live roster");
  const { projectId, tz } = useSession();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"" | ClockState | "alerts">("");
  const roster = useLoad(() => get<Roster>(`/v1/admin/roster${qs({ project_id: projectId })}`), [projectId]);
  const alerts = useLoad(() => get<{ alerts: Alert[] }>(`/v1/admin/alerts${qs({ project_id: projectId })}`), [projectId]);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    const poll = window.setInterval(() => {
      void roster.reload().then(() => setLoadedAt(Date.now()));
      void alerts.reload();
    }, 30_000);
    const t = window.setInterval(() => setTick(Date.now()), 15_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const ack = async (id: string) => {
    await post(`/v1/admin/alerts/${id}/ack`);
    void alerts.reload();
  };

  if (roster.error && !roster.data) return <ErrorNotice error={roster.error} onRetry={roster.reload} />;
  if (!roster.data) return <Loading label="Loading roster" />;
  const d = roster.data;
  const since = (tick - loadedAt) / 1000;
  const rows = d.tutors
    .filter((r) => !search || r.tutor.name.toLowerCase().includes(search.toLowerCase()) || r.tutor.email.includes(search.toLowerCase()))
    .filter((r) => !stateFilter || (stateFilter === "alerts" ? r.alerts.length > 0 : r.state === stateFilter))
    .sort((a, b) => b.alerts.length - a.alerts.length || ORDER[a.state] - ORDER[b.state] || a.tutor.name.localeCompare(b.tutor.name));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Live roster</h1>
          <p className="muted small" aria-live="off">
            Updates every 30 seconds. Last updated {since < 20 ? "just now" : `${Math.round(since)} seconds ago`}.
          </p>
        </div>
        <button className="btn" onClick={() => { void roster.reload().then(() => setLoadedAt(Date.now())); void alerts.reload(); }}>
          Refresh
        </button>
      </div>

      <div className="tally" role="group" aria-label="Summary">
        <div><div className="n">{d.totals.clocked_in}</div><div className="l">Clocked in</div></div>
        <div><div className="n">{d.totals.on_break}</div><div className="l">On break</div></div>
        <div><div className="n">{d.totals.clocked_out}</div><div className="l">Clocked out</div></div>
        <div><div className="n">{d.totals.with_alerts}</div><div className="l">Need attention</div></div>
        <div><div className="n"><Link to="/admin/corrections">{d.totals.pending_corrections}</Link></div><div className="l">Corrections waiting</div></div>
      </div>

      {alerts.data && alerts.data.alerts.length > 0 && (
        <section className="section" aria-labelledby="alerts-h" style={{ marginTop: 0, marginBottom: "1.5rem" }}>
          <h2 id="alerts-h">Alerts</h2>
          <ul className="list">
            {alerts.data.alerts.slice(0, 8).map((a) => (
              <li key={a.id} className="list-row">
                <span>
                  <strong>{a.title}</strong>
                  <br />
                  <span className="small muted">
                    {a.body}, {ago(a.scheduled_at)}
                  </span>
                </span>
                <span className="btn-row">
                  {a.related_entity_id && a.event_type !== "correction_submitted" && (
                    <Link className="btn" to={`/admin/sessions/${a.related_entity_id}`}>
                      Review
                    </Link>
                  )}
                  {a.event_type === "correction_submitted" && (
                    <Link className="btn" to="/admin/corrections">
                      Review
                    </Link>
                  )}
                  <button className="btn btn-quiet" onClick={() => void ack(a.id)}>
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="filters">
        <div className="field">
          <label htmlFor="q">Search tutors</label>
          <input id="q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or email" />
        </div>
        <div className="field">
          <label htmlFor="st">Show</label>
          <select id="st" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as typeof stateFilter)}>
            <option value="">Everyone</option>
            <option value="IN">Clocked in</option>
            <option value="BREAK">On break</option>
            <option value="OUT">Clocked out</option>
            <option value="alerts">Needs attention</option>
          </select>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data stack-sm">
          <caption className="visually-hidden">Tutors and their current clock status</caption>
          <thead>
            <tr>
              <th scope="col">Tutor</th>
              <th scope="col">Status</th>
              <th scope="col">Since</th>
              <th scope="col" className="num">This session</th>
              <th scope="col" className="num">Today</th>
              <th scope="col">Location</th>
              <th scope="col">Attention</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">No tutors match.</td>
              </tr>
            )}
            {rows.map((r) => {
              const s = r.active_session;
              const elapsed = s ? s.effective.work_seconds + (r.state === "IN" ? (tick - loadedAt) / 1000 : 0) : 0;
              return (
                <tr key={r.tutor.id}>
                  <td data-label="Tutor">
                    {s ? <Link to={`/admin/sessions/${s.id}`}>{r.tutor.name}</Link> : <Link to={`/admin/entries?tutor_id=${r.tutor.id}`}>{r.tutor.name}</Link>}
                    {r.tutor.team && <div className="small muted">{r.tutor.team}</div>}
                  </td>
                  <td data-label="Status"><StateBadge state={r.state} /></td>
                  <td data-label="Since" className="num">{s ? time(s.effective.start, tz) : "—"}</td>
                  <td data-label="This session" className="num">{s ? hm(elapsed) : "—"}</td>
                  <td data-label="Today" className="num">{hm(r.today_seconds + (r.state === "IN" && s ? (tick - loadedAt) / 1000 : 0))}</td>
                  <td data-label="Location">{s?.location?.name ?? "—"}</td>
                  <td data-label="Attention">
                    <Flags flags={r.alerts} />
                    {r.pending_corrections > 0 && <Link to="/admin/corrections" className="small">{r.pending_corrections} correction{r.pending_corrections > 1 ? "s" : ""}</Link>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
