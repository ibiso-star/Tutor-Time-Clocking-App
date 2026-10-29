import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, qs } from "../../api";
import { useSession } from "../../session";
import { day, hm, time, todayIn } from "../../format";
import { ErrorNotice, Flags, Loading, useLoad, useTitle, type Flag } from "../../components/ui";

interface Entry {
  id: string;
  tutor: { id: string; name: string };
  state: string;
  local_date: string;
  raw: { work_seconds: number; break_seconds: number };
  effective: { start: string; end: string | null; work_seconds: number };
  rounded_minutes: number;
  location: { name: string | null } | null;
  flags: Flag[];
}

export default function Entries() {
  useTitle("Time entries");
  const { projectId, tz } = useSession();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(0);
  const f = {
    from: params.get("from") ?? todayIn(tz, -6),
    to: params.get("to") ?? todayIn(tz),
    tutor_id: params.get("tutor_id") ?? "",
    location_id: params.get("location_id") ?? "",
    status: params.get("status") ?? "",
    flag: params.get("flag") ?? "",
    q: params.get("q") ?? "",
  };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(0);
  };
  const people = useLoad(() => get(`/v1/admin/people${qs({ project_id: projectId })}`), [projectId]);
  const locations = useLoad(() => get(`/v1/admin/locations${qs({ project_id: projectId })}`), [projectId]);
  const limit = 50;
  const { data, error, loading, reload } = useLoad(
    () => get<{ entries: Entry[]; total: number; total_seconds: number }>(`/v1/admin/time-entries${qs({ project_id: projectId, ...f, limit, offset: page * limit })}`),
    [projectId, params.toString(), page],
  );
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Time entries</h1>
          <p className="muted small">Sessions are listed on the date they started, in {tz}.</p>
        </div>
      </div>
      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter entries">
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" type="date" value={f.from} onChange={(e) => e.target.value && set("from", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" type="date" value={f.to} onChange={(e) => e.target.value && set("to", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tutor">Tutor</label>
          <select id="tutor" value={f.tutor_id} onChange={(e) => set("tutor_id", e.target.value)}>
            <option value="">All tutors</option>
            {people.data?.people.filter((p: any) => p.role === "tutor").map((p: any) => (
              <option key={p.user_id} value={p.user_id}>{p.display_name}{p.active_to ? " (former)" : ""}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="loc">Location</label>
          <select id="loc" value={f.location_id} onChange={(e) => set("location_id", e.target.value)}>
            <option value="">Any location</option>
            {locations.data?.locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Session</label>
          <select id="status" value={f.status} onChange={(e) => set("status", e.target.value)}>
            <option value="">Open and closed</option>
            <option value="open">Still open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="flag">Review state</label>
          <select id="flag" value={f.flag} onChange={(e) => set("flag", e.target.value)}>
            <option value="">Everything</option>
            <option value="any">Anything flagged</option>
            <option value="long_session">Long session</option>
            <option value="missed_clock_out">Missed clock-out</option>
            <option value="long_break">Long break</option>
            <option value="location_review">Location review</option>
            <option value="pending_correction">Correction pending</option>
            <option value="adjusted">Adjusted</option>
            <option value="voided">Voided</option>
          </select>
        </div>
      </form>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <p>
              {data.total} session{data.total === 1 ? "" : "s"}, <strong className="num">{hm(data.total_seconds)}</strong> worked.
            </p>
            <div className="table-wrap">
              <table className="data stack-sm">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Tutor</th>
                    <th scope="col">Start</th>
                    <th scope="col">End</th>
                    <th scope="col" className="num">Breaks</th>
                    <th scope="col" className="num">Worked</th>
                    <th scope="col">Location</th>
                    <th scope="col">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.length === 0 && (
                    <tr><td colSpan={8} className="empty">No sessions match these filters.</td></tr>
                  )}
                  {data.entries.map((e) => (
                    <tr key={e.id}>
                      <td data-label="Date"><Link to={`/admin/sessions/${e.id}`}>{day(e.local_date)}</Link></td>
                      <td data-label="Tutor">{e.tutor.name}</td>
                      <td data-label="Start" className="num">{time(e.effective.start, tz)}</td>
                      <td data-label="End" className="num">{e.effective.end ? time(e.effective.end, tz) : <span className="status status-in">Open</span>}</td>
                      <td data-label="Breaks" className="num">{hm(e.raw.break_seconds)}</td>
                      <td data-label="Worked" className="num">{hm(e.effective.work_seconds)}</td>
                      <td data-label="Location">{e.location?.name ?? "—"}</td>
                      <td data-label="Review"><Flags flags={e.flags} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.total > limit && (
              <div className="btn-row" style={{ marginTop: "1rem" }}>
                <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous page</button>
                <span className="muted small">Page {page + 1} of {Math.ceil(data.total / limit)}</span>
                <button className="btn" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>Next page</button>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
