import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, get, post, qs } from "../../api";
import { useSession } from "../../session";
import { clockDigits, dateTime, hm, localHour, time, timeWithSeconds, todayIn } from "../../format";
import { Dialog, ErrorNotice, Flags, Loading, ReviewStatus, stateText, useAnnounce, useOnline, useTitle, type ClockState, type Flag } from "../../components/ui";
import { IconPause, IconPlay, IconStop, IconWifiOff } from "../../components/icons";

interface Session {
  id: string;
  state: "in" | "break" | "closed";
  local_date: string;
  started_at: string;
  location: { id: string; name: string | null } | null;
  raw: { breaks: { start: string; end: string | null }[] };
  effective: { start: string; end: string | null; work_seconds: number };
  flags: Flag[];
  correction_status: string | null;
}
interface Status {
  project: { id: string; name: string; timezone: string };
  state: ClockState;
  session: Session | null;
  today: { date: string; work_seconds: number; sessions: number };
  next_shift: { id: string; label: string; scheduled_start: string; scheduled_end: string; location_id: string | null; location_name: string | null } | null;
  policy: {
    breaks_enabled: boolean;
    clock_out_while_on_break: "require_end" | "allow_combined";
    require_location: boolean;
    confirm_clock_out: boolean;
    location_controls_enabled: boolean;
  };
  locations: { id: string; name: string; geofence_mode: "off" | "warn" | "block" }[];
  server_time: string;
}
type Command = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END";

const DONE: Record<Command, string> = { CLOCK_IN: "Clocked in", CLOCK_OUT: "Clocked out", BREAK_START: "Break started", BREAK_END: "Break ended" };

export default function TutorHome() {
  const { projectId, tz } = useSession();
  const announce = useAnnounce();
  const online = useOnline();
  const [status, setStatus] = useState<Status | null>(null);
  const [today, setToday] = useState<Session[]>([]);
  const [recent, setRecent] = useState<Session[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState<Command | null>(null);
  const [locationId, setLocationId] = useState("");
  const [confirmOut, setConfirmOut] = useState(false);
  const [justChanged, setJustChanged] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fetchedAt = useRef({ client: Date.now(), skew: 0 });
  // An unanswered command keeps its idempotency key so a retry can never record it twice.
  const inflight = useRef<{ command: Command; key: string } | null>(null);
  useTitle(status ? stateText(status.state) : "Clock");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [s, entries] = await Promise.all([
        get<Status>(`/v1/me/time-status${qs({ project_id: projectId })}`),
        get<{ entries: Session[] }>(`/v1/me/time-entries${qs({ project_id: projectId, from: todayIn(tz, -7), to: todayIn(tz) })}`),
      ]);
      fetchedAt.current = { client: Date.now(), skew: new Date(s.server_time).getTime() - Date.now() };
      setStatus(s);
      setToday(entries.entries.filter((e) => e.local_date === s.today.date));
      setRecent(entries.entries.filter((e) => e.state === "closed").slice(0, 5));
      setLoadError(null);
      if (!locationId && s.locations.length) {
        setLocationId(s.next_shift?.location_id ?? (s.locations.length === 1 ? s.locations[0]!.id : ""));
      }
    } catch (e) {
      setLoadError(e);
    }
  }, [projectId, tz, locationId]);

  useEffect(() => {
    void load();
    const refresh = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", refresh);
    const poll = window.setInterval(() => void load(), 60_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(poll);
    };
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const send = async (command: Command, extra: Record<string, unknown> = {}) => {
    if (!projectId || pending) return;
    if (!inflight.current || inflight.current.command !== command) inflight.current = { command, key: crypto.randomUUID() };
    setPending(command);
    setActionError(null);
    setWarnings([]);
    try {
      let coords: { lat: number; lng: number; accuracy_m: number } | null = null;
      const loc = status?.locations.find((l) => l.id === locationId);
      if (command === "CLOCK_IN" && status?.policy.location_controls_enabled && loc && loc.geofence_mode !== "off") {
        coords = await currentPosition();
      }
      const res = await post<{ server_timestamp: string; warnings: string[]; replayed: boolean; status: Status }>(
        "/v1/clock-events",
        { project_id: projectId, event_type: command, location_id: command === "CLOCK_IN" ? locationId || null : undefined, shift_id: command === "CLOCK_IN" ? currentShiftId(status) : undefined, coords, ...extra },
        { "Idempotency-Key": inflight.current.key },
      );
      inflight.current = null;
      fetchedAt.current = { client: Date.now(), skew: new Date(res.status.server_time).getTime() - Date.now() };
      setStatus(res.status);
      setWarnings(res.warnings);
      setJustChanged(true);
      window.setTimeout(() => setJustChanged(false), 600);
      announce(`${DONE[command]} at ${timeWithSeconds(res.server_timestamp, tz)}.`);
      void load();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Something went wrong.");
      // Only a network failure leaves the outcome unknown; keep the key so "Try again" is safe.
      if (!err.isNetwork) inflight.current = null;
      setActionError(err);
      if (err.status === 409) void load();
    } finally {
      setPending(null);
    }
  };

  if (loadError && !status) return <ErrorNotice error={loadError} onRetry={load} />;
  if (!status) return <Loading label="Loading your clock" />;

  const serverNow = now + fetchedAt.current.skew;
  const sinceFetch = Math.max(0, (now - fetchedAt.current.client) / 1000);
  const s = status.session;
  const workSeconds = s ? s.effective.work_seconds + (status.state === "IN" ? sinceFetch : 0) : 0;
  const openBreak = s?.raw.breaks.find((b) => !b.end);
  const breakSeconds = openBreak ? (serverNow - new Date(openBreak.start).getTime()) / 1000 : 0;
  const todayTotal = status.today.work_seconds + (status.state === "IN" && s && s.local_date === status.today.date ? sinceFetch : 0);
  const canAct = online && !pending;
  const p = status.policy;
  const needsLocation = p.require_location && !locationId;
  const geoLoc = status.locations.find((l) => l.id === locationId && l.geofence_mode !== "off");

  return (
    <div>
      {!online && (
        <div className="notice notice-warn" role="status">
          <p>
            <strong>
              <IconWifiOff size={16} /> You're offline.
            </strong>{" "}
            Clock actions need a connection so the server can record the official time. Nothing is saved on this device.
          </p>
        </div>
      )}

      <section className="clock-face" aria-labelledby="clock-state" data-just-changed={justChanged}>
        <div className="clock-state" data-state={status.state}>
          <h1 id="clock-state">
            {status.state === "IN" ? <IconPlay size={26} /> : status.state === "BREAK" ? <IconPause size={26} /> : <IconStop size={26} />}
            {stateText(status.state)}
          </h1>
          {s?.location?.name && <span className="muted small">{s.location.name}</span>}
        </div>

        {status.state === "OUT" ? (
          status.today.sessions ? (
            <>
              <p className="clock-digits" aria-label={`Worked today: ${hm(todayTotal)}`}>
                {hm(todayTotal).replace("h ", ":").replace("m", "")}
              </p>
              <p className="clock-sub">
                Worked today across {status.today.sessions} session{status.today.sessions > 1 ? "s" : ""}
              </p>
            </>
          ) : (
            <p className="clock-ready">Ready to start your shift?</p>
          )
        ) : status.state === "IN" ? (
          <>
            <p className="clock-digits" role="timer" aria-label={`Working for ${hm(workSeconds)}`}>
              {clockDigits(workSeconds)}
            </p>
            <p className="clock-sub">
              Since {time(s!.effective.start, tz)}, {hm(todayTotal)} today
            </p>
          </>
        ) : (
          <>
            <p className="clock-digits" role="timer" aria-label={`On break for ${hm(breakSeconds)}`}>
              {clockDigits(breakSeconds)}
            </p>
            <p className="clock-sub">
              Break since {time(openBreak?.start, tz)}, {hm(workSeconds)} worked this session
            </p>
          </>
        )}

        {s && s.flags.length > 0 && (
          <p>
            <Flags flags={s.flags} />
          </p>
        )}

        {status.state === "OUT" && status.locations.length > 0 && (
          <div className="field">
            <label htmlFor="loc">Work location{p.require_location ? "" : " (optional)"}</label>
            <select id="loc" value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-describedby={geoLoc ? "geo-note" : undefined}>
              <option value="">{p.require_location ? "Choose a location" : "No location"}</option>
              {status.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {geoLoc && p.location_controls_enabled && (
              <span className="hint" id="geo-note">
                This location checks your position once, at clock-in, to confirm you're on site. It isn't tracked afterwards.
                {geoLoc.geofence_mode === "block" ? " If location is unavailable you can request a review." : ""}
              </span>
            )}
          </div>
        )}

        {actionError && (
          <div className="notice notice-error" role="alert">
            <p>
              {actionError.isNetwork ? (
                <>
                  <strong>Not recorded.</strong> We couldn't reach the server, so this action was not recorded. Trying again is safe; it will only ever be counted once.
                </>
              ) : (
                actionError.message
              )}
            </p>
            {actionError.isNetwork && inflight.current && (
              <button className="btn" onClick={() => void send(inflight.current!.command)} disabled={!online}>
                Try again
              </button>
            )}
          </div>
        )}
        {warnings.map((w) => (
          <div key={w} className="notice notice-warn" role="status">
            <p>{w}</p>
          </div>
        ))}

        <div className="clock-actions">
          {status.state === "OUT" && (
            <button className="btn btn-primary punch" disabled={!canAct || needsLocation} onClick={() => void send("CLOCK_IN")} aria-describedby={needsLocation ? "loc" : undefined}>
              <IconPlay size={22} />
              {pending === "CLOCK_IN" ? "Clocking in…" : "Clock in"}
            </button>
          )}
          {status.state === "IN" && (
            <>
              <button className="btn punch punch-out" disabled={!canAct} onClick={() => (p.confirm_clock_out ? setConfirmOut(true) : void send("CLOCK_OUT"))}>
                <IconStop size={22} />
                {pending === "CLOCK_OUT" ? "Clocking out…" : "Clock out"}
              </button>
              {p.breaks_enabled && (
                <button className="btn" disabled={!canAct} onClick={() => void send("BREAK_START")}>
                  <IconPause />
                  {pending === "BREAK_START" ? "Starting break…" : "Start break"}
                </button>
              )}
            </>
          )}
          {status.state === "BREAK" && (
            <>
              <button className="btn btn-primary punch" disabled={!canAct} onClick={() => void send("BREAK_END")}>
                <IconPlay size={22} />
                {pending === "BREAK_END" ? "Ending break…" : "End break"}
              </button>
              {p.clock_out_while_on_break === "allow_combined" ? (
                <button className="btn" disabled={!canAct} onClick={() => void send("CLOCK_OUT", { end_open_break: true })}>
                  <IconStop />
                  {pending === "CLOCK_OUT" ? "Clocking out…" : "End break and clock out"}
                </button>
              ) : (
                <p className="small muted">End your break before clocking out.</p>
              )}
            </>
          )}
        </div>

        <Timecard sessions={today} tz={tz} serverNow={serverNow} />
      </section>

      {status.next_shift && (
        <section className="section" aria-labelledby="next-shift">
          <h2 id="next-shift">Next shift</h2>
          <div className="panel">
            <p className="primary" style={{ fontWeight: 700, margin: 0 }}>
              {status.next_shift.label}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              {dateTime(status.next_shift.scheduled_start, tz)} to {time(status.next_shift.scheduled_end, tz)}
              {status.next_shift.location_name ? `, ${status.next_shift.location_name}` : ""}
            </p>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="recent">
        <div className="section-head">
          <h2 id="recent">Recent sessions</h2>
          <Link to="/history">All history</Link>
        </div>
        {recent.length === 0 ? (
          <p className="empty">No completed sessions yet. They'll appear here after you clock out.</p>
        ) : (
          <ul className="list">
            {recent.map((e) => (
              <li key={e.id}>
                <Link className="list-row" to={`/history/${e.id}`}>
                  <span>
                    <span className="primary">{new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(e.effective.start))}</span>
                    <br />
                    <span className="muted small">
                      {time(e.effective.start, tz)} to {time(e.effective.end, tz)}
                    </span>
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
        )}
      </section>

      <Dialog open={confirmOut} onClose={() => setConfirmOut(false)} title="Clock out now?">
        <p>You've worked {hm(workSeconds)} this session. The server records your clock-out time when you confirm.</p>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={() => {
              setConfirmOut(false);
              void send("CLOCK_OUT");
            }}
          >
            Clock out
          </button>
          <button className="btn" onClick={() => setConfirmOut(false)}>
            Keep working
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function currentShiftId(status: Status | null): string | undefined {
  const sh = status?.next_shift;
  if (!sh) return undefined;
  const now = Date.now();
  return new Date(sh.scheduled_start).getTime() - 60 * 60_000 <= now && now <= new Date(sh.scheduled_end).getTime() ? sh.id : undefined;
}

function currentPosition(): Promise<{ lat: number; lng: number; accuracy_m: number } | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) }),
      () => resolve(null), // Denied/unavailable: the server applies the project's fallback policy.
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    ),
  );
}

/** Today's work (solid) and breaks (hatched) laid on a day track — a paper timecard, digitised. */
function Timecard({ sessions, tz, serverNow }: { sessions: Session[]; tz: string; serverNow: number }) {
  const nowH = localHour(serverNow, tz);
  const segs = sessions.map((s) => ({
    start: localHour(s.effective.start, tz),
    end: s.effective.end ? localHour(s.effective.end, tz) : nowH,
    open: !s.effective.end,
    breaks: s.raw.breaks.map((b) => ({ start: localHour(b.start, tz), end: b.end ? localHour(b.end, tz) : nowH })),
  }));
  const lo = Math.floor(Math.min(7, nowH, ...segs.map((x) => x.start)));
  const hi = Math.ceil(Math.max(19, nowH + 0.5, ...segs.map((x) => (x.end < x.start ? 24 : x.end))));
  const span = Math.max(1, hi - lo);
  const pct = (h: number) => `${((Math.min(Math.max(h, lo), hi) - lo) / span) * 100}%`;
  const width = (a: number, b: number) => `${((Math.min(b < a ? 24 : b, hi) - Math.max(a, lo)) / span) * 100}%`;
  const label = (h: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, h % 24));
  const summary = segs.length
    ? segs.map((x) => `worked ${label(Math.floor(x.start))} to ${x.open ? "now" : label(Math.floor(x.end))}`).join("; ")
    : "no sessions yet today";
  return (
    <figure className="timecard" style={{ margin: "1.25rem 0 0" }}>
      <figcaption className="visually-hidden">Today's timecard: {summary}.</figcaption>
      <div className="timecard-track" style={{ ["--hours" as string]: span }} aria-hidden="true">
        {segs.map((x, i) => (
          <div key={i}>
            <div className={`timecard-seg${x.open ? " open" : ""}`} style={{ left: pct(x.start), width: width(x.start, x.end) }} />
            {x.breaks.map((b, j) => (
              <div key={j} className="timecard-seg break" style={{ left: pct(b.start), width: width(b.start, b.end) }} />
            ))}
          </div>
        ))}
        <div className="timecard-now" style={{ left: pct(nowH) }} />
      </div>
      <div className="timecard-scale" aria-hidden="true">
        <span>{label(lo)}</span>
        <span>{label(Math.round((lo + hi) / 2))}</span>
        <span>{label(hi)}</span>
      </div>
    </figure>
  );
}
