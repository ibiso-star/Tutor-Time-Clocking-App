import { useState } from "react";
import { Link } from "react-router-dom";
import { get, qs } from "../../api";
import { useSession } from "../../session";
import { day, hm, time, todayIn } from "../../format";
import { ErrorNotice, Flags, Loading, ReviewStatus, useLoad, useTitle, type Flag } from "../../components/ui";

interface Entry {
  id: string;
  state: string;
  local_date: string;
  effective: { start: string; end: string | null; work_seconds: number };
  flags: Flag[];
  correction_status: string | null;
  location: { name: string | null } | null;
}

export default function History() {
  useTitle("History");
  const { projectId, tz } = useSession();
  const [from, setFrom] = useState(todayIn(tz, -13));
  const [to, setTo] = useState(todayIn(tz));
  const { data, error, loading, reload } = useLoad(
    () => get<{ entries: Entry[]; total_seconds: number }>(`/v1/me/time-entries${qs({ project_id: projectId, from, to })}`),
    [projectId, from, to],
  );
  const byDay = new Map<string, Entry[]>();
  for (const e of data?.entries ?? []) byDay.set(e.local_date, [...(byDay.get(e.local_date) ?? []), e]);

  return (
    <div>
      <h1>Time history</h1>
      <div className="filters">
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data && data.entries.length === 0 ? (
        <p className="empty">No sessions in this period.</p>
      ) : (
        data && (
          <>
            <p>
              Total for this period: <strong className="num">{hm(data.total_seconds)}</strong>
            </p>
            {[...byDay.entries()].map(([d, entries]) => (
              <section key={d} className="section" aria-labelledby={`d-${d}`}>
                <div className="section-head">
                  <h2 id={`d-${d}`}>{day(d)}</h2>
                  <span className="num muted">{hm(entries.reduce((s, e) => s + e.effective.work_seconds, 0))}</span>
                </div>
                <ul className="list">
                  {entries.map((e) => (
                    <li key={e.id}>
                      <Link className="list-row" to={`/history/${e.id}`}>
                        <span>
                          <span className="primary num">
                            {time(e.effective.start, tz)} to {e.effective.end ? time(e.effective.end, tz) : "now"}
                          </span>
                          {e.location?.name && <span className="muted small"> at {e.location.name}</span>}
                          <br />
                          <Flags flags={e.flags.filter((f) => f.code !== "pending_correction")} />
                        </span>
                        <span style={{ textAlign: "right" }}>
                          <span className="num" style={{ fontWeight: 700 }}>
                            {hm(e.effective.work_seconds)}
                          </span>
                          {e.correction_status && (
                            <>
                              <br />
                              <ReviewStatus status={e.correction_status} />
                            </>
                          )}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )
      )}
    </div>
  );
}
