import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { get, qs } from "./api";
import { useSession } from "./session";
import { IconCalendar, IconClock, IconFile, IconInbox, IconList, IconSettings, IconShield, IconUser, IconUsers } from "./components/icons";

export function TutorShell() {
  const { membership } = useSession();
  return (
    <div className="tutor-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="tutor-top">
        <span className="project">{membership?.project.name}</span>
        <span className="small muted">{membership?.project.timezone}</span>
      </header>
      <main id="main" className="tutor-main" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end>
          <IconClock size={22} />
          Clock
        </NavLink>
        <NavLink to="/history">
          <IconList size={22} />
          History
        </NavLink>
        <NavLink to="/requests">
          <IconInbox size={22} />
          Requests
        </NavLink>
        <NavLink to="/profile">
          <IconUser size={22} />
          Profile
        </NavLink>
      </nav>
    </div>
  );
}

export function AdminShell() {
  const { membership, me, selectProject, projectId } = useSession();
  const [pending, setPending] = useState(0);
  const [alerts, setAlerts] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    const load = () => {
      get(`/v1/admin/correction-requests${qs({ project_id: projectId })}`).then((r) => setPending(r.corrections.length)).catch(() => undefined);
      get(`/v1/admin/alerts${qs({ project_id: projectId })}`).then((r) => setAlerts(r.alerts.length)).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [projectId]);
  const isAdmin = membership?.role === "admin";
  const count = (n: number, label: string) =>
    n > 0 ? (
      <span className="badge-count" aria-label={`${n} ${label}`}>
        {n}
      </span>
    ) : null;
  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="admin-nav" aria-label="Admin">
        <div className="brand">
          <IconClock size={22} /> Time Clock
        </div>
        {me && me.memberships.length > 1 && (
          <select aria-label="Project" value={projectId ?? ""} onChange={(e) => selectProject(e.target.value)} style={{ marginBottom: "0.75rem" }}>
            {me.memberships.map((m) => (
              <option key={m.project.id} value={m.project.id}>
                {m.project.name}
              </option>
            ))}
          </select>
        )}
        <NavLink to="/admin" end>
          <span><IconClock /> Live roster</span>
          {count(alerts, "unacknowledged alerts")}
        </NavLink>
        <NavLink to="/admin/entries">
          <span><IconList /> Time entries</span>
        </NavLink>
        <NavLink to="/admin/corrections">
          <span><IconInbox /> Corrections</span>
          {count(pending, "pending corrections")}
        </NavLink>
        <NavLink to="/admin/exports">
          <span><IconFile /> Exports</span>
        </NavLink>
        <NavLink to="/admin/people">
          <span><IconUsers /> People</span>
        </NavLink>
        <NavLink to="/admin/schedule">
          <span><IconCalendar /> Locations &amp; shifts</span>
        </NavLink>
        <NavLink to="/admin/settings">
          <span><IconSettings /> Settings</span>
        </NavLink>
        {isAdmin && (
          <NavLink to="/admin/audit">
            <span><IconShield /> Audit log</span>
          </NavLink>
        )}
        <div className="spacer" />
        <NavLink to="/admin/profile">
          <span><IconUser /> {me?.user.display_name}</span>
        </NavLink>
      </nav>
      <main id="main" className="admin-main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
